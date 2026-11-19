const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const XLSX = require('xlsx');
const mammoth = require('mammoth');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let pg = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pg = new Pool({ connectionString: process.env.DATABASE_URL });
  } catch (_) {}
}

const upload = multer({ dest: 'uploads/', limits: { fileSize: 10 * 1024 * 1024 } });
const rooms = new Map();
const roomCodes = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () => Array.from({ length: 6 }, () => roomCodes[Math.floor(Math.random() * roomCodes.length)]).join('');

const roomsBySocket = new Map();
const characters = ['Công chúa','Hoàng tử','Dũng sĩ','Cảnh sát','Tiên nữ','Ma cà rồng','Phù thủy','Thám tử'];
const roomNames = ['Bệnh viện ma ám','Lâu đài bỏ hoang','Khu rừng ma quái','Đại dịch Zombie'];

function seedQuestion(roomId, i) {
  const pools = {
    1: [['Hành lang nào thuộc căn phòng bệnh viện ma ám?','A', 'Hành lang bệnh viện','Hành lang rừng','Đại dương','Thang máy vũ trụ'],['Ai xuất hiện trong bệnh viện ma ám?','C','Zombie','Tiên rừng','Bác sĩ ma','Bộ xương'],['Thiết bị nào thường có trong bệnh viện?','B','Nấm khổng lồ','Giường bệnh','Cái chổi','Thanh kiếm']],
    2: [['Kiến trúc Gothic thường gắn với?','D','Rạp xiếc','Trạm xăng','Bãi biển','Lâu đài cổ'],['Nhân vật nào phù hợp với lâu đài?','A','Ma cà rồng quý tộc','Zombie đầu bếp','Thỏ ma','Sadako'],['Nơi có phòng ngai vàng là?','C','Khu rừng','Bệnh viện','Lâu đài','Thành phố zombie']],
    3: [['Đom đóm phát sáng nhiều trong?','B','Bệnh viện','Khu rừng','Phòng thí nghiệm','Lâu đài'],['Nhân vật nào sống trong rừng ma?','C','Zombie','Bác sĩ ma','Tiên rừng','Ma cà rồng quý tộc'],['Hồ phát sáng thuộc không gian nào?','A','Khu rừng ma quái','Lâu đài','Bệnh viện','Thành phố']],
    4: [['Ai chiếm đóng thành phố trong căn phòng này?','D','Công chúa','Bác sĩ','Tiên nữ','Zombie'],['Hiệu ứng an toàn dành cho zombie là?','B','Máu me','Hoạt hình vui nhộn','Chuyển thành kinh dị','Cấm hình ảnh'],['Trạm nào phù hợp trong thành phố zombie?','A','Trạm cứu hộ','Phòng chiếu phim','Phòng ngai vàng','Hồ tiên']] 
  };
  const base = pools[roomId] || pools[1];
  const q = base[(i - 1) % base.length];
  return { id:`${roomId}-${i}`, roomId, question:q[0], options:q.slice(2), correct:['A','B','C','D'].indexOf(q[1]), explanation:'Đáp án theo nội dung mô tả trong đề bài.' };
}

function buildQuestions() {
  const result = {};
  for (let r=1;r<=4;r++) {
    result[r]=[];
    for(let i=1;i<=30;i++) result[r].push(seedQuestion(r,i));
  }
  return result;
}

async function initDb() {
  if (pg) {
    await pg.query(`CREATE TABLE IF NOT EXISTS rooms(code text primary key, data jsonb, updated_at timestamptz default now())`);
    return;
  }
  for (const file of fs.readdirSync(path.join(__dirname,'data')).filter(f=>f.endsWith('.json'))) {
    try {
      const saved=JSON.parse(fs.readFileSync(path.join(__dirname,'data',file),'utf8'));
      saved.players=new Map((saved.playerList||[]).map(p=>[p.id,p]));
      rooms.set(saved.code,saved);
    } catch (_) {}
  }
}

async function saveRoom(room) {
  const snapshot={code:room.code,bossName:room.bossName,status:room.status,players:[...room.players.values()].map(p=>({...p,socketId:null,elapsedStarted:null})),questions:room.questions,itemRates:room.itemRates,createdAt:room.createdAt,playerList:[...room.players.values()].map(p=>({...p,socketId:null,elapsedStarted:null}))};
  if (!pg) {
    fs.writeFileSync(path.join(__dirname,'data',`${room.code}.json`), JSON.stringify(snapshot));
    return;
  }
  await pg.query('INSERT INTO rooms(code,data) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET data=$2, updated_at=now()', [room.code, JSON.stringify(snapshot)]);
}

function publicRoom(room) {
  return { code:room.code, status:room.status, bossName:room.bossName, itemRates:room.itemRates,
    players:[...room.players.values()].map(p=>({id:p.id,name:p.name,character:p.character,roomId:p.roomId,score:p.score,correct:p.correct,wrong:p.wrong,answered:p.answered,completed:p.completed,items:p.items,connected:p.connected})),
    questionsCount:Object.fromEntries(Object.entries(room.questions).map(([k,v])=>[k,v.length])) };
}

function rankPlayers(room) {
  return [...room.players.values()].filter(p=>p.completed).sort((a,b)=>b.score-a.score || a.elapsed-b.elapsed || b.correct-a.correct || b.validReversals-a.validReversals);
}

io.on('connection', socket => {
  socket.on('boss:create', async ({bossName='Boss'}, ack) => {
    let code; do code=makeCode(); while(rooms.has(code));
    const room={code,bossName,status:'waiting',bossSocket:socket.id,players:new Map(),questions:buildQuestions(),itemRates:{magic:20,fairy:20,time:15},createdAt:Date.now()};
    rooms.set(code,room); roomsBySocket.set(socket.id,{code,role:'boss'});
    socket.join(code); await saveRoom(room).catch(()=>{}); ack?.({ok:true,room:publicRoom(room)});
  });

  socket.on('room:join', ({code,name='Chưa đặt tên',character='Công chúa',resumeId}, ack) => {
    code=(code||'').toUpperCase(); const room=rooms.get(code);
    if(!room) return ack?.({ok:false,error:'Không tìm thấy mã phòng.'});
    if(room.status==='playing' && resumeId && room.players.has(resumeId)) { const p=room.players.get(resumeId); p.connected=true; p.socketId=socket.id; roomsBySocket.set(socket.id,{code,role:'player',id:resumeId}); socket.join(code); io.to(code).emit('room:update',publicRoom(room)); return ack?.({ok:true,room:publicRoom(room),playerId:resumeId,resumed:true}); }
    if(room.status!== 'waiting') return ack?.({ok:false,error:'Phòng đã bắt đầu.'});
    if(room.players.size>=30) return ack?.({ok:false,error:'Phòng đã đủ 30 người.'});
    if(!characters.includes(character)) character='Công chúa';
    const id=resumeId || socket.id+'-'+Date.now();
    const player={id,name:name.trim().slice(0,24)||'Người chơi',character,roomId:null,score:0,correct:0,wrong:0,answered:[],completed:false,elapsed:0,elapsedStarted:null,items:{magic:0,fairy:0,time:1},validReversals:0,connected:true,socketId:socket.id,freezeUntil:0,wrongFreezes:0};
    room.players.set(id,player); roomsBySocket.set(socket.id,{code,role:'player',id}); socket.join(code);
    io.to(code).emit('room:update',publicRoom(room)); ack?.({ok:true,room:publicRoom(room),playerId:id});
  });

  socket.on('boss:start', ({code,itemRates}, ack) => {
    const meta=roomsBySocket.get(socket.id); const room=meta&&rooms.get(meta.code||code);
    if(!room || meta?.role!=='boss') return;
    room.status='playing'; room.itemRates={magic:Number(itemRates?.magic||20),fairy:Number(itemRates?.fairy||20),time:Number(itemRates?.time||15)};
    for(const p of room.players.values()){ p.elapsedStarted=Date.now(); }
    io.to(room.code).emit('game:start',publicRoom(room)); saveRoom(room).catch(()=>{}); ack?.({ok:true});
  });

  socket.on('player:enter-room', ({roomId}, ack) => {
    const meta=roomsBySocket.get(socket.id); if(!meta||meta.role!=='player')return;
    const room=rooms.get(meta.code); const p=room?.players.get(meta.id); if(!room||!p||p.roomId) return;
    if(![1,2,3,4].includes(Number(roomId))) return;
    p.roomId=Number(roomId); p.questions=[...room.questions[roomId]].sort(()=>Math.random()-0.5).slice(0,10); p.current=0;
    io.to(room.code).emit('room:update',publicRoom(room)); ack?.({ok:true,question:p.questions[0],index:0,score:p.score});
  });

  socket.on('player:answer', ({answerIndex,questionIndex}, ack) => {
    const meta=roomsBySocket.get(socket.id); const room=meta&&rooms.get(meta.code); const p=room?.players.get(meta.id);
    if(!room||!p||p.completed||p.roomId==null) return ack?.({ok:false,error:'Không thể trả lời.'});
    if(p.freezeUntil>Date.now()) return ack?.({ok:false,error:'Bạn đang bị đóng băng.'});
    const q=p.questions[questionIndex??p.current]; if(!q) return;
    if(p.answered.some(a=>a.index===p.current)) return ack?.({ok:false,error:'Câu hỏi đã được ghi nhận.'});
    const correct=answerIndex===q.correct;
    p.answered.push({index:p.current,correct,answerIndex,at:Date.now()});
    if(correct){ p.score+=20;p.correct++;const r=Math.random()*100;if(r<room.itemRates.magic)p.items.magic=(p.items.magic||0)+1;else if(r<room.itemRates.magic+room.itemRates.fairy)p.items.fairy=(p.items.fairy||0)+1;else if(r<room.itemRates.magic+room.itemRates.fairy+room.itemRates.time)p.items.time=Math.min(1,(p.items.time||0)+1); }
    else{p.wrong++; if(p.wrong>3){p.wrongFreezes++;p.freezeUntil=Date.now()+15000;} }
    p.current++;
    if(p.current>=10){p.completed=true;p.elapsed=p.elapsedStarted?Math.max(1,Math.floor((Date.now()-p.elapsedStarted)/1000)):0;}
    io.to(room.code).emit('room:update',publicRoom(room));
    saveRoom(room).catch(()=>{});
    ack?.({ok:true,correct,score:p.score,item:null,next:p.completed?null:p.questions[p.current],index:p.current,completed:p.completed,freezeUntil:p.freezeUntil,ranking:rankPlayers(room).length?rankPlayers(room).map(x=>x.name):[]});
  });

  socket.on('player:item', ({item,targetId,questionIndex}, ack) => {
    const meta=roomsBySocket.get(socket.id); const room=meta&&rooms.get(meta.code); const p=room?.players.get(meta.id);
    if(!room||!p) return;
    if(item==='magic'&&p.items.magic>0){p.items.magic--;const q=p.questions[p.current];const wrong=[0,1,2,3].filter(i=>i!==q.correct).sort(()=>Math.random()-0.5).slice(0,1);return ack?.({ok:true,remove:[...new Set([q.correct,wrong[0]])],kept:[q.correct,wrong[0]]});}
    if(item==='fairy'&&p.items.fairy>0&&room.players.has(targetId)){p.items.fairy--;const target=room.players.get(targetId);target.freezeUntil=Date.now()+10000;io.to(room.code).emit('room:update',publicRoom(room));return ack?.({ok:true,until:target.freezeUntil});}
    if(item==='time'&&p.items.time>0){const wrong=p.answered.filter(a=>!a.correct);if(!wrong.length)return ack?.({ok:false,error:'Chưa có câu sai.'});p.items.time--;const a=wrong[0];a.reversal=true;p.validReversals++;return ack?.({ok:true,questionIndex:a.index});}
    ack?.({ok:false,error:'Vật phẩm không khả dụng.'});
  });

  socket.on('boss:end', ({code}, ack) => {
    const meta=roomsBySocket.get(socket.id); const room=meta&&rooms.get(meta.code||code); if(!room)return;
    room.status='ended'; io.to(room.code).emit('game:end',{ranking:rankPlayers(room).map((p,i)=>({...p,rank:i+1}))}); saveRoom(room).catch(()=>{}); ack?.({ok:true});
  });

  socket.on('disconnect',()=>{const meta=roomsBySocket.get(socket.id);if(meta?.role==='player'){const room=rooms.get(meta.code);const p=room?.players.get(meta.id);if(p)p.connected=false; if(room)io.to(room.code).emit('room:update',publicRoom(room));}roomsBySocket.delete(socket.id);});
});

app.post('/api/upload/:code', upload.single('file'), async (req,res) => {
  const room=rooms.get((req.params.code||'').toUpperCode?.() || (req.params.code||'').toUpperCase());
  if(!room) return res.status(404).json({error:'Không tìm thấy phòng'});
  if(!req.file) return res.status(400).json({error:'Thiếu tệp'});
  try{
    let rows=[];
    if(req.file.originalname.toLowerCase().endsWith('.xlsx')||req.file.originalname.toLowerCase().endsWith('.xls')){
      const wb=XLSX.readFile(req.file.path); const ws=wb.Sheets[wb.SheetNames[0]]; rows=XLSX.utils.sheet_to_json(ws,{defval:''});
    }else{
      const result=await mammoth.extractRawText({path:req.file.path});
      const parts=result.value.split(/(?=Mã câu hỏi|Câu\s*\d+)/i).filter(Boolean);
      rows=parts.map((text,i)=>{const lines=text.split('\n').map(x=>x.trim()).filter(Boolean); const opts=(text.match(/[A-D][.)]\s*([^\n]+)/g)||[]).map(x=>x.replace(/^[A-D][.)]\s*/,''));const correct=(text.match(/Đáp án đúng[:\s]*([A-D])/i)||[])[1]||'A';const roomMatch=(text.match(/(?:Tên căn phòng|Căn phòng)[:\s]*(\d)/i)||[])[1]||'1';return {'Mã câu hỏi':`DOC-${i+1}`,'Tên căn phòng':roomMatch,'Nội dung câu hỏi':lines.find(x=>x&&!/Mã câu hỏi|Căn phòng|A[.)]|B[.)]|C[.)]|D[.)]|Đáp án đúng/i.test(x))||text.slice(0,100),'Đáp án A':opts[0]||'','Đáp án B':opts[1]||'','Đáp án C':opts[2]||'','Đáp án D':opts[3]||'','Đáp án đúng':correct,'Giải thích đáp án':''};});
    }
    const imported=[];for(const row of rows){const roomId=Number(String(row['Tên căn phòng']||row['Room']||row.room||'1').match(/[1-4]/)?.[0]||1);if(![1,2,3,4].includes(roomId))continue;const answer=(row['Đáp án đúng']||row['correct']||'A');const correct=['A','B','C','D'].indexOf(String(answer).trim().toUpperCase());const q={id:String(row['Mã câu hỏi']||row.id||`UP-${Date.now()}-${imported.length}`),roomId,question:String(row['Nội dung câu hỏi']||row.question||''),options:['Đáp án A','Đáp án B','Đáp án C','Đáp án D'].map(k=>String(row[k]||row[k.replace('Đáp án ','') ]||'')),correct:correct>=0?correct:0,explanation:String(row['Giải thích đáp án']||row.explanation||'')};if(q.question&&q.options.filter(Boolean).length>=2)imported.push(q);}
    for(const q of imported){room.questions[q.roomId]=room.questions[q.roomId].filter(x=>x.id!==q.id);room.questions[q.roomId].push(q)}
    await saveRoom(room).catch(()=>{});res.json({ok:true,imported:imported.length});
  }finally{fs.unlink(req.file.path,()=>{})}
});

app.get('/api/room/:code',(req,res)=>{const room=rooms.get(req.params.code.toUpperCase());res.json(room?publicRoom(room):{error:'Không tìm thấy phòng'})});

initDb().then(()=>server.listen(process.env.PORT||3000,()=>console.log(`Căn Phòng Bí Ẩn đang chạy tại http://localhost:${process.env.PORT||3000}`))).catch(e=>server.listen(process.env.PORT||3000,()=>console.log('Chạy ở chế độ lưu cục bộ')));
