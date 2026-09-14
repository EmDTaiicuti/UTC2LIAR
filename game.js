/* =======================================================
   CÀ PHÊ BỆT — NÓI DỐI — bluffing card game, P2P online via PeerJS
   Host is authoritative; clients send actions, host broadcasts state.
   Avatars are real 3D rigged models (glTF, embedded as base64) with
   idle animation, rendered per-player through three.js.
   (Plain classic script — not type="module" — so this still works
   when the file is opened directly, e.g. double-clicked / file://.)
======================================================= */

const GLTFLoader = THREE.GLTFLoader;
const SkeletonUtils = THREE.SkeletonUtils;

const RANKS = ['A','K','Q'];
const RANK_LABEL = {A:'Á', K:'K', Q:'Q', JOKER:'★'};

// =======================================================
// 3D AVATAR SYSTEM
// Model: rigged humanoid glTF with 'Idle' / 'Walk' animation clips,
// embedded below as base64 so the whole game stays one file and
// works offline / from a local file:// path too.
// =======================================================


const AVATAR_TINT = {
  nam: 0x2f8ca3, // teal, matches --stool-blue
  nu:  0xd9503d, // red, matches --stool-red
};

let baseModelScene = null;
let baseAnimations = null;
let modelReady = false;
const modelReadyQueue = [];

function onModelReady(cb){
  if(modelReady) cb();
  else modelReadyQueue.push(cb);
}

function base64ToArrayBuffer(base64){
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

(function loadBaseModel(){
  const loader = new GLTFLoader();
  const buffer = base64ToArrayBuffer(MODEL_BASE64);
  loader.parse(buffer, '', (gltf)=>{
    baseModelScene = gltf.scene;
    baseAnimations = gltf.animations;
    modelReady = true;
    modelReadyQueue.forEach(cb=>cb());
    modelReadyQueue.length = 0;
  }, (err)=>{ console.error('Không tải được model 3D:', err); });
})();

// live instances, keyed by e.g. "opp:<playerId>" / "lobby:<playerId>" / "me:" / "picker:<type>"
const avatarInstances = new Map();

function destroyAvatarInstance(key){
  const inst = avatarInstances.get(key);
  if(!inst) return;
  cancelAnimationFrame(inst.raf);
  inst.renderer.dispose();
  inst.mixer.stopAllAction();
  if(inst.renderer.domElement.parentNode) inst.renderer.domElement.parentNode.removeChild(inst.renderer.domElement);
  avatarInstances.delete(key);
}

function destroyContext(prefix){
  [...avatarInstances.keys()].filter(k=>k.startsWith(prefix)).forEach(destroyAvatarInstance);
}

// container: DOM element to mount the canvas into (should be empty)
// key: unique instance key
// avatarType: 'nam' | 'nu'
// opts: { width, height, anim: 'Idle'|'Walk', dead: bool }
// Fallback shown if 3D rendering fails for any reason (no WebGL, blocked CDN, etc.)
// so avatar selection / player rows never end up silently blank.
function mountAvatarFallback(container, avatarType){
  container.innerHTML = '';
  const dot = document.createElement('div');
  const tint = avatarType === 'nu' ? '#d9503d' : '#2f8ca3';
  dot.style.width = '100%';
  dot.style.height = '100%';
  dot.style.borderRadius = '50%';
  dot.style.background = tint;
  dot.style.display = 'flex';
  dot.style.alignItems = 'center';
  dot.style.justifyContent = 'center';
  dot.style.color = '#fff';
  dot.style.fontFamily = "'Baloo 2', sans-serif";
  dot.style.fontWeight = '700';
  dot.textContent = avatarType === 'nu' ? '♀' : '♂';
  container.appendChild(dot);
}

function mountAvatar3D(container, key, avatarType, opts={}){
  if(!baseModelScene){ mountAvatarFallback(container, avatarType); return null; }
  const width = opts.width || 60;
  const height = opts.height || 74;

  try{
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(26, width/height, 0.1, 100);

    const renderer = new THREE.WebGLRenderer({ alpha:true, antialias:true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xfff3df, 0x3a2c1e, 2.4));
    const dir = new THREE.DirectionalLight(0xffffff, 1.3);
    dir.position.set(2, 4, 3);
    scene.add(dir);

    const model = SkeletonUtils.clone(baseModelScene);
    const tint = AVATAR_TINT[avatarType] || AVATAR_TINT.nam;
    model.traverse(o=>{
      if(o.isMesh && o.material){
        if(!Array.isArray(o.material) && o.material.name === 'VanguardBodyMat'){
          o.material = o.material.clone();
          o.material.color = new THREE.Color(tint);
        } else if(Array.isArray(o.material)){
          o.material = o.material.map(m=>{
            if(m.name === 'VanguardBodyMat'){
              const mm = m.clone();
              mm.color = new THREE.Color(tint);
              return mm;
            }
            return m;
          });
        }
      }
    });
    scene.add(model);

    // Auto-fit the camera to the model's real bounding box (computed from
    // its bind pose) instead of a hardcoded guess, so the character is
    // always fully visible regardless of the source model's scale/origin.
    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const fitDist = (maxDim / 2) / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.55;
    camera.position.set(center.x, center.y + size.y * 0.02, center.z + fitDist);
    camera.near = Math.max(fitDist / 100, 0.01);
    camera.far = fitDist * 100;
    camera.lookAt(center.x, center.y, center.z);
    camera.updateProjectionMatrix();

    const mixer = new THREE.AnimationMixer(model);
    const clock = new THREE.Clock();

    const inst = { renderer, scene, camera, mixer, clock, model, currentAction:null, currentClip:null, raf:null };
    avatarInstances.set(key, inst);
    applyAvatarPose(inst, opts);
  } catch(err){
    if(window.debugLog) window.debugLog('Không dựng được nhân vật 3D (' + key + '): ' + (err && err.message ? err.message : err));
    console.error('Không dựng được nhân vật 3D, dùng ảnh thay thế:', err);
    mountAvatarFallback(container, avatarType);
    return null;
  }
  const inst = avatarInstances.get(key);

  function loop(){
    inst.raf = requestAnimationFrame(loop);
    inst.mixer.update(inst.clock.getDelta());
    inst.renderer.render(inst.scene, inst.camera);
  }
  loop();
  return inst;
}

function applyAvatarPose(inst, opts){
  if(opts.dead){
    if(inst.currentAction) inst.currentAction.stop();
    inst.model.rotation.z = -Math.PI/2.1;
    inst.model.position.y = -0.35;
    inst.currentClip = 'dead';
    return;
  }
  inst.model.rotation.z = 0;
  inst.model.position.y = 0;
  const wanted = opts.anim || 'Idle';
  if(inst.currentClip === wanted) return;
  const clip = THREE.AnimationClip.findByName(baseAnimations, wanted) || baseAnimations[0];
  const action = inst.mixer.clipAction(clip);
  if(inst.currentAction) inst.currentAction.fadeOut(0.25);
  action.reset().fadeIn(0.25).play();
  inst.currentAction = action;
  inst.currentClip = wanted;
}

// Renders (creating if needed) a 3D avatar into `container` under `key`.
function renderAvatarSlot(container, key, avatarType, opts){
  onModelReady(()=>{
    let inst = avatarInstances.get(key);
    if(!inst){
      inst = mountAvatar3D(container, key, avatarType, opts);
    } else {
      applyAvatarPose(inst, opts);
    }
  });
}

let peer = null;
let isHost = false;
let myId = null;
let myName = '';
let myAvatar = 'nam';
let connections = {}; // host: peerId -> DataConnection
let hostConn = null;  // client: connection to host

let state = null;     // authoritative game state (mirrored on all clients)
let selectedCardUids = [];

// ---------- DOM ----------
const screens = {
  home: document.getElementById('homeScreen'),
  lobby: document.getElementById('lobbyScreen'),
  game: document.getElementById('gameScreen'),
};
function showScreen(name){
  Object.values(screens).forEach(s=>s.classList.remove('active'));
  screens[name].classList.add('active');
}

function showOverlay(title, text, btnLabel, onClick){
  document.getElementById('overlayTitle').textContent = title;
  document.getElementById('overlayText').textContent = text;
  const btn = document.getElementById('overlayBtn');
  btn.textContent = btnLabel || 'Đóng';
  btn.onclick = () => {
    document.getElementById('overlay').classList.remove('active');
    if(onClick) onClick();
  };
  document.getElementById('overlay').classList.add('active');
}

// ---------- avatar picker (home screen, 3D preview) ----------
document.querySelectorAll('.avatar-choice').forEach(el=>{
  const wrap = document.createElement('div');
  wrap.className = 'avatar3d-wrap';
  wrap.style.width = '64px';
  wrap.style.height = '78px';
  const lbl = document.createElement('div');
  lbl.className = 'lbl';
  lbl.textContent = el.dataset.avatar === 'nam' ? 'Nam' : 'Nữ';
  el.appendChild(wrap);
  el.appendChild(lbl);
  renderAvatarSlot(wrap, 'picker:'+el.dataset.avatar, el.dataset.avatar, {width:64, height:78, anim:'Idle'});
  el.onclick = ()=>{
    document.querySelectorAll('.avatar-choice').forEach(x=>x.classList.remove('selected'));
    el.classList.add('selected');
    myAvatar = el.dataset.avatar;
  };
});

// ---------- Helpers ----------
function uid(){ return Math.random().toString(36).slice(2,9); }

function buildDeck(numPlayers){
  const perRank = Math.max(6, numPlayers * 2);
  let deck = [];
  RANKS.forEach(r=>{
    for(let i=0;i<perRank;i++) deck.push({uid: uid(), rank: r});
  });
  for(let i=0;i<2;i++) deck.push({uid: uid(), rank:'JOKER'});
  for(let i=deck.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]]=[deck[j],deck[i]];
  }
  return deck;
}

function makeRevolver(){
  const chambers = [false,false,false,false,false,false];
  chambers[Math.floor(Math.random()*6)] = true;
  return { chambers, pointer: 0 };
}

function log(msg){
  state.log.push(msg);
  if(state.log.length > 60) state.log.shift();
}

// =======================================================
// HOST-SIDE GAME LOGIC
// =======================================================

function hostInitState(){
  state = {
    phase: 'lobby',
    players: [],
    turnOrder: [],
    currentTurnIdx: 0,
    targetRank: null,
    pile: [],
    lastPlay: null,
    log: [],
    winnerId: null,
  };
}

function hostAddPlayer(id, name, avatar){
  if(state.players.find(p=>p.id===id)) return;
  state.players.push({ id, name, avatar: avatar==='nu' ? 'nu' : 'nam', hand:[], alive:true, revolver: makeRevolver(), connected:true });
  log(`${name} vừa kéo ghế ngồi xuống.`);
}

function hostStartGame(){
  if(state.players.length < 2) return;
  state.players.forEach(p=>{ p.alive = true; });
  state.phase = 'playing';
  state.turnOrder = state.players.map(p=>p.id);
  state.currentTurnIdx = 0;
  log('Ván mới bắt đầu! Chúc may mắn.');
  hostStartRound(true);
}

function alivePlayers(){ return state.players.filter(p=>p.alive); }

function hostStartRound(firstRound){
  const alive = alivePlayers();
  const deck = buildDeck(alive.length);
  const perPlayer = Math.floor(deck.length / alive.length);
  let idx = 0;
  alive.forEach(p=>{
    p.hand = deck.slice(idx, idx+perPlayer);
    idx += perPlayer;
  });
  state.targetRank = RANKS[Math.floor(Math.random()*RANKS.length)];
  state.pile = [];
  state.lastPlay = null;
  log(`Ván bài mới: lá phải khai là "${RANK_LABEL[state.targetRank]}".`);
  hostFixTurnOrder();
}

function hostFixTurnOrder(){
  state.turnOrder = state.turnOrder.filter(id => state.players.find(p=>p.id===id && p.alive));
  if(state.turnOrder.length===0){
    state.turnOrder = alivePlayers().map(p=>p.id);
  }
  if(state.currentTurnIdx >= state.turnOrder.length) state.currentTurnIdx = 0;
}

function currentPlayerId(){ return state.turnOrder[state.currentTurnIdx]; }

function advanceTurn(fromId){
  hostFixTurnOrder();
  if(state.turnOrder.length <= 1) return;
  let idx = state.turnOrder.indexOf(fromId);
  if(idx === -1) idx = state.currentTurnIdx;
  state.currentTurnIdx = (idx + 1) % state.turnOrder.length;
}

function hostCheckGameOver(){
  const alive = alivePlayers();
  if(alive.length <= 1){
    state.phase = 'gameover';
    state.winnerId = alive[0] ? alive[0].id : null;
    log(alive[0] ? `${alive[0].name} là người trụ lại quán cuối cùng!` : 'Không còn ai trụ lại.');
    return true;
  }
  return false;
}

function hostHandlePlay(playerId, cardUids){
  if(state.phase !== 'playing') return 'Ván chưa bắt đầu hoặc đã kết thúc.';
  if(currentPlayerId() !== playerId) return 'Chưa tới lượt của bạn (chủ quán ghi nhận lượt khác).';
  const player = state.players.find(p=>p.id===playerId);
  if(!player) return 'Chủ quán không thấy bạn trong ván chơi (id không khớp).';
  if(!player.alive) return 'Bạn đã bị loại khỏi ván này.';
  if(!cardUids || cardUids.length < 1 || cardUids.length > 3) return 'Số lá chọn không hợp lệ (phải 1-3 lá).';
  const cards = [];
  for(const cu of cardUids){
    const c = player.hand.find(x=>x.uid===cu);
    if(!c){ return 'Lá bài đã chọn không còn trên tay (dữ liệu không khớp, thử tải lại trang).'; }
    cards.push(c);
  }
  player.hand = player.hand.filter(c=>!cardUids.includes(c.uid));
  state.pile.push({ playerId, cards, claimedCount: cards.length });
  state.lastPlay = { playerId, claimedCount: cards.length };
  log(`${player.name} úp ${cards.length} lá xuống mâm, khai là "${RANK_LABEL[state.targetRank]}".`);

  if(player.hand.length === 0){
    log(`${player.name} đã hết bài trên tay!`);
  }
  advanceTurn(playerId);
  return true;
}

function hostHandleChallenge(challengerId){
  if(state.phase !== 'playing') return 'Ván chưa bắt đầu hoặc đã kết thúc.';
  if(currentPlayerId() !== challengerId) return 'Chưa tới lượt của bạn (chủ quán ghi nhận lượt khác).';
  if(state.pile.length === 0) return 'Chưa có ai úp bài để mà bắt bịp.';
  const top = state.pile[state.pile.length-1];
  const challenger = state.players.find(p=>p.id===challengerId);
  const accused = state.players.find(p=>p.id===top.playerId);
  const allMatch = top.cards.every(c=> c.rank === state.targetRank || c.rank === 'JOKER');

  let loser;
  if(allMatch){
    log(`${challenger.name} tố "Nói dối!" nhưng ${accused.name} nói THẬT. ${challenger.name} lãnh đủ.`);
    loser = challenger;
  } else {
    log(`${challenger.name} tố "Nói dối!" và bắt đúng — ${accused.name} đã BỊP. ${accused.name} lãnh đủ.`);
    loser = accused;
  }

  const revealStr = top.cards.map(c=>RANK_LABEL[c.rank]).join(', ');
  log(`Bài lật ra: ${revealStr}.`);

  const r = loser.revolver;
  const fatal = r.chambers[r.pointer];
  r.pointer++;
  if(fatal){
    loser.alive = false;
    log(`💥 Đoàng! ${loser.name} rời quán, không dậy nổi khỏi ghế nhựa.`);
  } else {
    log(`Xịt! ${loser.name} còn hên, chưa sao.`);
  }

  const gameOver = hostCheckGameOver();
  if(!gameOver){
    const startFrom = loser.id;
    advanceTurn(startFrom);
    hostStartRound(false);
  }
  return true;
}

function hostHandleAction(playerId, action){
  let result = true;
  if(action.type === 'play'){
    result = hostHandlePlay(playerId, action.cardUids);
  } else if(action.type === 'challenge'){
    result = hostHandleChallenge(playerId);
  } else if(action.type === 'restart'){
    state.players.forEach(p=>{ p.revolver = makeRevolver(); });
    hostStartGame();
  }
  // if the action was rejected (result is a string reason, not true), tell whoever sent it
  if(typeof result === 'string'){
    if(playerId === myId){
      debugLog('Hành động "' + action.type + '" bị từ chối: ' + result);
    } else if(connections[playerId] && connections[playerId].open){
      connections[playerId].send({ type:'debug', message: 'Hành động "' + action.type + '" bị từ chối: ' + result });
    }
  }
  broadcastState();
}

// ---------- Sanitize state per-recipient ----------
function sanitizedStateFor(viewerId){
  const s = JSON.parse(JSON.stringify(state));
  s.players = s.players.map(p=>{
    if(p.id === viewerId) return p;
    return { ...p, hand: p.hand.map(()=>({uid:null, rank:'HIDDEN'})) };
  });
  s.pile = s.pile.map(play=>({ playerId: play.playerId, claimedCount: play.claimedCount }));
  return s;
}

function broadcastState(){
  if(!isHost) return;
  renderAll(sanitizedStateFor(myId));
  Object.entries(connections).forEach(([pid, conn])=>{
    if(conn.open){
      conn.send({ type:'state', state: sanitizedStateFor(pid) });
    }
  });
}

// =======================================================
// NETWORKING
// =======================================================

function initPeer(onOpen){
  peer = new Peer(undefined, { debug: 1 });
  peer.on('open', id=>{ myId = id; onOpen(id); });
  peer.on('error', err=>{
    console.error(err);
    debugLog('Lỗi PeerJS: ' + err.type);
    document.getElementById('homeError').textContent = 'Lỗi kết nối: ' + err.type + '. Thử lại nhé.';
    resetJoinButtons();
  });
  peer.on('disconnected', ()=>{
    debugLog('Mất kết nối tới máy chủ tiếp sóng (signaling). Nếu hành động không còn phản hồi, hãy tải lại trang và vào lại phòng.');
  });
}

function hostSetupConnectionHandlers(){
  peer.on('connection', conn=>{
    connections[conn.peer] = conn;
    conn.on('data', data=>{
      if(data.type === 'join'){
        hostAddPlayer(conn.peer, data.name, data.avatar);
        conn.send({ type:'welcome', yourId: conn.peer });
        broadcastState();
        renderLobby();
      } else if(data.type === 'action'){
        hostHandleAction(conn.peer, data.action);
      }
    });
    conn.on('close', ()=>{
      const p = state.players.find(pl=>pl.id===conn.peer);
      if(p){ p.connected = false; log(`${p.name} đứng dậy rời quán.`); broadcastState(); renderLobby(); }
      delete connections[conn.peer];
    });
  });
}

function clientSendAction(action){
  if(isHost){
    hostHandleAction(myId, action);
  } else if(hostConn && hostConn.open){
    hostConn.send({ type:'action', action });
  } else {
    debugLog('Không gửi được hành động "' + action.type + '": ' + (!hostConn ? 'chưa có kết nối tới chủ quán' : 'kết nối tới chủ quán đã đóng') + '. Thử thoát ra vào lại phòng.');
  }
}

// =======================================================
// UI: HOME
// =======================================================

let peerInitStarted = false;

function resetJoinButtons(){
  peerInitStarted = false;
  const cb = document.getElementById('createBtn');
  const jb = document.getElementById('joinBtn');
  cb.disabled = false; cb.textContent = 'Tạo phòng mới';
  jb.disabled = false; jb.textContent = 'Vào phòng';
}

document.getElementById('createBtn').onclick = ()=>{
  if(peerInitStarted) return;
  peerInitStarted = true;
  const btn = document.getElementById('createBtn');
  btn.disabled = true;
  btn.textContent = 'Đang tạo phòng...';
  const name = document.getElementById('nameInput').value.trim() || 'Chủ quán';
  myName = name;
  document.getElementById('homeError').textContent = '';
  isHost = true;
  initPeer(id=>{
    hostInitState();
    hostSetupConnectionHandlers();
    hostAddPlayer(id, myName, myAvatar);
    document.getElementById('roomCodeDisplay').textContent = id;
    showScreen('lobby');
    renderLobby();
  });
};

document.getElementById('joinBtn').onclick = ()=>{
  if(peerInitStarted) return;
  const name = document.getElementById('nameInput').value.trim() || 'Khách';
  const code = document.getElementById('codeInput').value.trim();
  if(!code){ document.getElementById('homeError').textContent = 'Nhập mã phòng đã nhé.'; return; }
  peerInitStarted = true;
  const btn = document.getElementById('joinBtn');
  btn.disabled = true;
  btn.textContent = 'Đang vào phòng...';
  myName = name;
  document.getElementById('homeError').textContent = '';
  isHost = false;
  initPeer(id=>{
    hostConn = peer.connect(code, { reliable:true });
    hostConn.on('open', ()=>{
      hostConn.send({ type:'join', name: myName, avatar: myAvatar });
      showScreen('lobby');
      document.getElementById('roomCodeDisplay').textContent = code;
      document.getElementById('startGameBtn').style.display='none';
      document.getElementById('waitingHost').style.display='block';
    });
    hostConn.on('data', data=>{
      if(data.type === 'welcome'){
        myId = data.yourId;
        debugLog('Đã nhận ID của bạn từ chủ quán: ' + myId);
      }
      else if(data.type === 'state'){
        if(!myId) debugLog('Cảnh báo: nhận trạng thái ván chơi nhưng chưa có ID của bạn — hành động của bạn có thể không hoạt động.');
        onStateReceived(data.state);
      }
      else if(data.type === 'debug'){
        debugLog(data.message);
      }
    });
    hostConn.on('error', err=>{
      debugLog('Lỗi kết nối tới chủ quán: ' + (err && err.type ? err.type : err));
      document.getElementById('homeError').textContent = 'Không vào được phòng. Kiểm tra mã phòng.';
      resetJoinButtons();
    });
    hostConn.on('close', ()=>{
      debugLog('Mất kết nối tới chủ quán. Các nút hành động sẽ không còn phản hồi — cần vào lại phòng.');
    });
  });
};

document.getElementById('roomCodeDisplay').onclick = ()=>{
  const txt = document.getElementById('roomCodeDisplay').textContent;
  navigator.clipboard?.writeText(txt);
};

document.getElementById('startGameBtn').onclick = ()=>{
  if(isHost) hostStartGame();
  broadcastState();
};

// =======================================================
// RENDER
// =======================================================

function onStateReceived(s){
  state = s;
  if(state.phase === 'lobby') renderLobby();
  else { showScreen('game'); renderAll(state); }
}

function renderLobby(){
  showScreen('lobby');
  destroyContext('lobby:');
  const list = document.getElementById('lobbyPlayers');
  list.innerHTML = '';
  state.players.forEach((p,i)=>{
    const li = document.createElement('li');

    const wrap = document.createElement('div');
    wrap.className = 'avatar3d-wrap';
    wrap.style.width = '30px';
    wrap.style.height = '36px';
    li.appendChild(wrap);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'lname';
    nameSpan.textContent = p.name + (p.id===myId ? ' (bạn)' : '');
    li.appendChild(nameSpan);

    if(i===0){
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'Chủ quán';
      li.appendChild(tag);
    }

    list.appendChild(li);
    renderAvatarSlot(wrap, 'lobby:'+p.id, p.avatar, {width:30, height:36, anim:'Idle'});
  });
  document.getElementById('startCount').textContent = state.players.length;
  if(isHost){
    document.getElementById('startGameBtn').style.display = 'block';
    document.getElementById('startGameBtn').disabled = state.players.length < 2;
    document.getElementById('waitingHost').style.display = 'none';
  } else {
    document.getElementById('startGameBtn').style.display = 'none';
    document.getElementById('waitingHost').style.display = 'block';
  }
}

function escapeHtml(s){ const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function renderAll(s){
  state = s;
  if(state.phase === 'lobby'){ renderLobby(); return; }
  showScreen('game');
  destroyContext('opp:');

  const me = state.players.find(p=>p.id===myId);
  const others = state.players.filter(p=>p.id!==myId);

  const oppWrap = document.getElementById('opponents');
  oppWrap.innerHTML = '';
  others.forEach(p=>{
    const div = document.createElement('div');
    div.className = 'opp-card' + (currentPlayerId()===p.id && state.phase==='playing' ? ' turn' : '') + (!p.alive ? ' dead':'');

    const avWrap = document.createElement('div');
    avWrap.className = 'avatar3d-wrap';
    avWrap.style.width = '56px';
    avWrap.style.height = '68px';
    div.appendChild(avWrap);

    const nameDiv = document.createElement('div');
    nameDiv.className = 'opp-name';
    nameDiv.textContent = p.name + (!p.alive ? ' ☠' : '');
    div.appendChild(nameDiv);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'opp-meta';
    metaDiv.textContent = p.hand.length + ' lá bài';
    div.appendChild(metaDiv);

    const revolverDiv = document.createElement('div');
    revolverDiv.className = 'revolver';
    p.revolver.chambers.forEach((c,i)=>{
      const ch = document.createElement('div');
      ch.className = 'chamber' + (i < p.revolver.pointer ? ' used' : '');
      revolverDiv.appendChild(ch);
    });
    div.appendChild(revolverDiv);

    oppWrap.appendChild(div);
    try{
      renderAvatarSlot(avWrap, 'opp:'+p.id, p.avatar, {
        width:56, height:68,
        anim: (currentPlayerId()===p.id && state.phase==='playing') ? 'Walk' : 'Idle',
        dead: !p.alive
      });
    } catch(err){
      debugLog('Lỗi hiện avatar đối thủ ('+p.name+'): ' + (err && err.message ? err.message : err));
      mountAvatarFallback(avWrap, p.avatar);
    }
  });

  const myAvatarWrapEl = document.getElementById('myAvatarWrap');
  myAvatarWrapEl.innerHTML = '';
  if(me){
    const meWrap = document.createElement('div');
    meWrap.className = 'avatar3d-wrap';
    meWrap.style.width = '38px';
    meWrap.style.height = '46px';
    meWrap.style.display = 'inline-block';
    myAvatarWrapEl.appendChild(meWrap);
    destroyContext('me:');
    try{
      renderAvatarSlot(meWrap, 'me:'+me.id, me.avatar, {
        width:38, height:46,
        anim: (currentPlayerId()===me.id && state.phase==='playing') ? 'Walk' : 'Idle',
        dead: !me.alive
      });
    } catch(err){
      debugLog('Lỗi hiện avatar của bạn: ' + (err && err.message ? err.message : err));
      mountAvatarFallback(meWrap, me.avatar);
    }
  }
  document.getElementById('myName').textContent = me ? me.name + ' (bạn)' : '';
  if(me){
    document.getElementById('myMeta').innerHTML = `${me.alive ? '' : '☠ đã rời quán · '}Ổ đạn: ` + me.revolver.chambers.map((c,i)=>`<span style="opacity:${i<me.revolver.pointer?1:0.35}">●</span>`).join(' ');
  }

  document.getElementById('targetBanner').innerHTML = state.phase==='playing'
    ? `Lá phải khai: <b>${RANK_LABEL[state.targetRank]}</b>`
    : 'Ván đã kết thúc';
  const pileArea = document.getElementById('pileArea');
  pileArea.innerHTML = '';
  const pileCount = state.pile.length;
  for(let i=0;i<Math.min(pileCount,6);i++){
    const mc = document.createElement('div');
    mc.className = 'mini-card';
    mc.textContent = '🂠';
    pileArea.appendChild(mc);
  }
  const lastClaimEl = document.getElementById('lastClaim');
  if(state.lastPlay){
    const lp = state.players.find(p=>p.id===state.lastPlay.playerId);
    lastClaimEl.innerHTML = `<b>${escapeHtml(lp ? lp.name : '?')}</b> vừa úp <b>${state.lastPlay.claimedCount}</b> lá, khai là "${RANK_LABEL[state.targetRank]}"`;
  } else {
    lastClaimEl.textContent = 'Chưa ai úp bài trong ván này.';
  }

  const turnInfo = document.getElementById('turnInfo');
  if(state.phase === 'playing'){
    const cur = state.players.find(p=>p.id===currentPlayerId());
    turnInfo.textContent = cur ? `Lượt của: ${cur.name}${cur.id===myId ? ' (bạn!)' : ''}` : '';
  } else if(state.phase === 'gameover'){
    turnInfo.textContent = '';
  }

  const actionsWrap = document.getElementById('actions');
  actionsWrap.innerHTML = '';
  const myTurn = state.phase==='playing' && currentPlayerId() === myId && me && me.alive;
  if(myTurn && state.pile.length > 0){
    const challengeBtn = document.createElement('button');
    challengeBtn.className = 'btn danger';
    challengeBtn.textContent = 'Nói dối! (bắt bịp)';
    challengeBtn.onclick = ()=> clientSendAction({ type:'challenge' });
    actionsWrap.appendChild(challengeBtn);
  }

  if(state.phase === 'gameover'){
    const winner = state.players.find(p=>p.id===state.winnerId);
    showOverlay(
      winner ? `${winner.name} thắng cuộc!` : 'Ván kết thúc',
      winner ? `${winner.name} là người duy nhất còn ngồi vững ở quán.` : 'Không ai trụ lại.',
      isHost ? 'Chơi lại' : 'Đóng',
      ()=>{ if(isHost) clientSendAction({type:'restart'}); }
    );
  }

  renderHand(me, myTurn);

  const logPanel = document.getElementById('logPanel');
  logPanel.innerHTML = state.log.map(l=>`<div>${escapeHtml(l)}</div>`).join('');
  logPanel.scrollTop = logPanel.scrollHeight;
}

function renderHand(me, myTurn){
  const handWrap = document.getElementById('hand');
  handWrap.innerHTML = '';
  if(!me) return;
  me.hand.forEach(c=>{
    const div = document.createElement('div');
    div.className = 'card' + (c.rank==='JOKER' ? ' joker':'') + (selectedCardUids.includes(c.uid) ? ' selected':'');
    div.textContent = RANK_LABEL[c.rank];
    div.onclick = ()=>{
      if(!myTurn) return;
      const i = selectedCardUids.indexOf(c.uid);
      if(i>=0){ selectedCardUids.splice(i,1); }
      else if(selectedCardUids.length < 3){ selectedCardUids.push(c.uid); }
      renderHand(me, myTurn);
      renderPlayControls(me, myTurn);
    };
    handWrap.appendChild(div);
  });
  renderPlayControls(me, myTurn);
}

function renderPlayControls(me, myTurn){
  const wrap = document.getElementById('playControls');
  wrap.innerHTML = '';
  if(!myTurn || !me || me.hand.length===0) return;
  const playBtn = document.createElement('button');
  playBtn.className = 'btn';
  playBtn.style.width = 'auto';
  playBtn.textContent = selectedCardUids.length > 0
    ? `Úp ${selectedCardUids.length} lá, khai "${RANK_LABEL[state.targetRank]}"`
    : 'Chọn 1-3 lá để úp';
  playBtn.disabled = selectedCardUids.length === 0;
  playBtn.onclick = ()=>{
    clientSendAction({ type:'play', cardUids: [...selectedCardUids] });
    selectedCardUids = [];
  };
  wrap.appendChild(playBtn);
}
