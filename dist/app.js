const DB_NAME='apiary-journal',DB_VERSION=1,STORE='notes',PRIMARY_MODEL='openai/gpt-oss-120b',BACKUP_MODEL='openai/gpt-oss-20b';
const CHAT_KEY='apiary-chat-v1',CLOSED_KEY='apiary-closed-tasks-v1';
let db,recorders={note:null,question:null},activeStreams={note:null,question:null},timers={},startedAt={note:0,question:0},chatHistory=readLocal(CHAT_KEY,[]),activeType='family',activeFilter='open';
const $=id=>document.getElementById(id),
  fmtDate=d=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',year:'numeric'}).format(new Date(d)),
  fmtDateTime=d=>new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}).format(new Date(d));
function readLocal(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback}catch{return fallback}}
function writeLocal(key,value){try{localStorage.setItem(key,JSON.stringify(value))}catch{}}
const closedTasks=()=>new Set(readLocal(CLOSED_KEY,[]));
const openDb=()=>new Promise((resolve,reject)=>{const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)});
const allNotes=()=>new Promise((resolve,reject)=>{const req=db.transaction(STORE,'readonly').objectStore(STORE).getAll();req.onsuccess=()=>resolve(req.result.sort((a,b)=>b.createdAt-a.createdAt));req.onerror=()=>reject(req.error)});
const saveNote=n=>new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(n);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});
function toast(text){const el=$('toast');el.textContent=text;el.classList.add('show');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('show'),3500)}
function status(text,offline=false){$('connection').querySelector('span').textContent=text;$('connection').classList.toggle('offline',offline)}
function settings(){return{key1:localStorage.getItem('api-key-1')||'',key2:localStorage.getItem('api-key-2')||''}}
function keyOrder(){const {key1,key2}=settings();return[{key:key1.trim(),model:PRIMARY_MODEL},{key:key2.trim(),model:BACKUP_MODEL}].filter((x,i,a)=>x.key&&a.findIndex(y=>y.key===x.key)===i)}
async function groq(path,init={}){
  const keys=keyOrder();if(!keys.length)throw new Error('Добавьте API-ключи Groq в настройках.');let last;
  for(let i=0;i<keys.length;i++){
    try{
      const request={...init,headers:{...(init.headers||{}),Authorization:`Bearer ${keys[i].key}`}};
      if(path==='/chat/completions'&&init.body){const body=JSON.parse(init.body);body.model=keys[i].model;request.body=JSON.stringify(body)}
      const res=await fetch('https://api.groq.com/openai/v1'+path,request);
      if(res.status===429){if(i<keys.length-1){last=new Error('LIMIT');continue}throw new Error('LIMIT')}
      if(res.status===401||res.status===403){last=new Error('AUTH');if(i<keys.length-1)continue;throw new Error('AUTH')}
      if(res.status>=500&&i<keys.length-1){last=new Error('UPSTREAM');continue}
      if(!res.ok){const detail=await res.text();let raw='';try{const payload=JSON.parse(detail);raw=payload.error?.message||payload.message||''}catch{}
        if(path==='/chat/completions'&&i<keys.length-1&&(res.status===400||res.status===404)&&/model|permission|access|available|not found/i.test(raw)){last=new Error('MODEL');continue}
        if(/failed to validate json/i.test(raw))throw new Error('Сервис не смог обработать ответ. Запись сохранена; повторите позже.');
        throw new Error(({400:'Сервис отклонил запрос. Повторите попытку.',401:'API-ключ не принят.',403:'У API-ключа нет доступа.',413:'Аудиозапись слишком большая.',415:'Формат аудио не поддерживается.',422:'Не удалось распознать запись.'}[res.status]||`Временная ошибка сервиса (${res.status}).`))
      }
      return res
    }catch(e){
      if(e.message==='LIMIT')throw new Error('Бесплатный лимит исчерпан на обоих ключах. Записи останутся в очереди.');
      if(['AUTH','UPSTREAM','MODEL'].includes(e.message)){last=e;continue}
      if(i<keys.length-1&&e instanceof TypeError){last=e;continue}
      throw e
    }
  }
  throw new Error(last?.message==='MODEL'?'Модели недоступны. Проверьте доступ к ним в Groq.':last?.message==='UPSTREAM'?'Groq временно недоступен. Попробуйте позже.':'Не удалось подключиться к Groq.')
}
async function transcribe(blob){const ext=blob.type.includes('mp4')?'m4a':'webm',file=new File([blob],`voice.${ext}`,{type:blob.type||'audio/webm'}),fd=new FormData();fd.append('file',file);fd.append('model','whisper-large-v3-turbo');fd.append('language','ru');fd.append('response_format','json');const res=await groq('/audio/transcriptions',{method:'POST',body:fd}),data=await res.json();return data.text?.trim()||''}
async function complete(prompt){const res=await groq('/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({temperature:.1,max_completion_tokens:3000,messages:[{role:'system',content:'Ты помощник пасечника. Отвечай только по-русски и только по переданному журналу. Не выдумывай. Учитывай, что семья, улей, ящик и пчелосемья с одинаковым номером — одно место. Отводок учитывай отдельно. Даты трактуй точно. Отвечай ясно и перечисляй каждую подходящую семью отдельно.'},{role:'user',content:prompt}]})}),data=await res.json();return data.choices?.[0]?.message?.content?.trim()||'Не удалось получить ответ.'}
function familyFrom(text){const t=String(text||'').toLowerCase().replaceAll('ё','е');const words={одна:1,один:1,первый:1,первая:1,первую:1,первого:1,первой:1,раз:1,два:2,две:2,второй:2,вторая:2,вторую:2,второго:2,три:3,третий:3,третья:3,третью:3,третьего:3,третьей:3,четыре:4,четвертый:4,четвертая:4,четвертой:4,пять:5,пятый:5,пятая:5,пятой:5,шесть:6,шестой:6,шестая:6,семь:7,седьмой:7,седьмая:7,восемь:8,восьмой:8,восьмая:8,девять:9,девятый:9,девятая:9,девятой:9,десять:10,десятый:10,десятая:10,десятой:10};const unit='(?:семь[яюие]|пчелосемь[яюие]|ул(?:ей|ья|ье|ью)|ящик|семейк[ауи]|отвод(?:ок|ка|ку|ке|ком)|нуклеус(?:а|е|ом)?)',num='(\\d+|одна|один|перв(?:ый|ая|ую|ого|ой)?|раз|два|две|втор(?:ой|ая|ую|ого)?|три|трет(?:ий|ья|ью|ьего|ьей)|четыре|четверт(?:ый|ая|ую)|пять|пят(?:ый|ая)|шесть|шест(?:ой|ая)|семь|седьм(?:ой|ая)|восемь|восьм(?:ой|ая)|девять|девят(?:ый|ая)|десять|десят(?:ый|ая))',between='(?:\\s+[а-я-]+){0,3}?';for(const p of[new RegExp(`${unit}${between}\\s*(?:номер\\s*)?${num}`,'i'),new RegExp(`${num}${between}\\s*${unit}`,'i')]){const m=p.exec(t);if(m)return Number(m[1])||words[m[1]]||null}return null}
function entityType(text,modelValue=''){if(modelValue==='nucleus')return'nucleus';if(modelValue==='family')return'family';if(/отводк|нуклеус/i.test(text))return'nucleus';return'family'}
function normalizeTranscript(text){return String(text||'').replace(/\b(?:апсидк\w*|обситк\w*|обседк\w*)\b/giu,'обсидка')}
function parseList(s){return String(s||'').split(/[;|]/).map(x=>x.trim()).filter(x=>x&& !/^(нет|неизвестно|null)$/i.test(x))}
function parseNumber(s){const m=String(s||'').match(/\d{1,4}/);return m?Number(m[0]):null}
function readField(raw,key){const m=raw.match(new RegExp('^\\s*'+key+'\\s*:\\s*(.*)$','im'));return m?m[1].trim():''}
function taskKey(type,family){return`${type}|${family??'unknown'}`}
function taskRows(notes,type,family){const closed=closedTasks(),rows=[],seen=new Set();for(const n of notes){if((n.entityType||entityType(n.transcript))!==type||(n.family??familyFrom(n.transcript)??null)!==(family??null))continue;for(const[index,text]of(n.analysis?.tasks||[]).entries()){const canonical=text.toLowerCase().replaceAll('ё','е').replace(/[^а-яa-z0-9]/g,'');if(seen.has(canonical))continue;seen.add(canonical);const id=`${n.id}:${index}`;rows.push({id,text,closed:closed.has(id),createdAt:n.createdAt,note:n})}}return rows}
async function analyzeTranscript(text,type,family,candidates){
  const taskContext=candidates.length?candidates.map(t=>`- ${t.text}`).join('\n'):'Открытых заданий пока нет.';
  const instructions=`Извлеки сведения из заметки пасечника. Ответь строками «ключ: значение», не JSON. Все значения по-русски, кроме кодов полей и entity_type.
family_number: номер цифрами или нет
entity_type: family или nucleus
queen_year: год цифрами или нет
strength: краткая оценка или нет
feed: краткое состояние кормов или нет
flight: краткая оценка облёта или нет
observations: прочие факты через точку с запятой или нет
tasks: будущие действия, которые ещё нужно сделать, через точку с запятой или нет
completed_tasks: выполненные сейчас действия, через точку с запятой или нет
confidence: high, medium или low
Семья, пчелосемья, улей и ящик с одним номером означают одну семью. Отводок и нуклеус — отдельный тип объекта nucleus. Если тип неясен, используй family. Пасечное слово «обсидка» сохраняй именно так. Год матки записывай только если он прямо назван. Не считай выполненное заданием. «Нужно/надо/планирую/хотел» означает задачу. «Сделал/поставил/дал/провёл» означает выполненное действие. Если текущая запись говорит, что ранее поставленная задача из списка выполнена, добавь в completed_tasks её точный текст из списка. Не закрывай похожие, но разные задачи. Текущий тип ${type}, номер ${family??'не распознан'}. Открытые задания этого объекта:\n${taskContext}\nЕсли неизвестно, пиши «нет».`;
  const res=await groq('/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({temperature:.1,max_completion_tokens:700,messages:[{role:'system',content:instructions},{role:'user',content:text}]})}),data=await res.json(),raw=data.choices?.[0]?.message?.content||'';
  const value=key=>{const v=readField(raw,key);return !v||/^(нет|неизвестно|null|n\/a)$/i.test(v)?null:v};
  return{family_number:parseNumber(value('family_number'))??family,entity_type:entityType(text,value('entity_type')),queen_year:parseNumber(value('queen_year')),strength:value('strength'),feed:value('feed'),flight:value('flight'),observations:parseList(value('observations')),tasks:parseList(value('tasks')),completed_tasks:parseList(value('completed_tasks')),confidence:(value('confidence')||'low').toLowerCase()}
}
function taskEquivalent(a,b){const norm=x=>String(x||'').toLowerCase().replaceAll('ё','е').replace(/[^а-яa-z0-9]/g,'');const x=norm(a),y=norm(b);return x===y||(Math.min(x.length,y.length)>8&&(x.includes(y)||y.includes(x)))}
async function enrichNote(note){
  const previous=await allNotes(),preType=entityType(note.transcript),preFamily=note.family??familyFrom(note.transcript),candidates=taskRows(previous,preType,preFamily).filter(t=>!t.closed);
  const analysis=await analyzeTranscript(note.transcript,preType,preFamily,candidates);note.analysis=analysis;note.entityType=analysis.entity_type;note.family=analysis.family_number;note.action=analysis.tasks.join('; ');note.status='done';
  if(analysis.completed_tasks.length){const closed=closedTasks();for(const candidate of candidates)if(analysis.completed_tasks.some(done=>taskEquivalent(candidate.text,done)))closed.add(candidate.id);writeLocal(CLOSED_KEY,[...closed])}
}
function appendChat(message){chatHistory.push({...message,createdAt:message.createdAt||Date.now()});chatHistory=chatHistory.slice(-120);writeLocal(CHAT_KEY,chatHistory);renderChat();if(message.role==='assistant')document.querySelector('.chat-panel').scrollIntoView({behavior:'smooth',block:'nearest'})}
function updateChatNote(note){const row=chatHistory.findLast?chatHistory.findLast(m=>m.noteId===note.id):[...chatHistory].reverse().find(m=>m.noteId===note.id);if(row){row.content=note.transcript||'Голосовая заметка записана. Ждёт подключения к интернету.';row.pending=note.status==='pending';writeLocal(CHAT_KEY,chatHistory);renderChat()}}
function renderChat(){const root=$('chat-messages');if(!chatHistory.length){root.innerHTML='<div class="chat-empty">Запишите заметку о семье или отводке либо задайте вопрос по журналу.</div>';return}root.innerHTML=chatHistory.map((m,i)=>`<article class="message ${m.role==='assistant'?'assistant':'user'} ${m.pending?'pending':''}">${escapeHtml(m.content)}${m.createdAt?`<time>${fmtDateTime(m.createdAt)}</time>`:''}${m.audioNote?`<button class="play-audio" data-chat-play="${escapeHtml(m.noteId)}">▶ Аудиозапись</button>`:''}${m.speak?`<button class="speak-answer" data-speak="${i}">▶ Прослушать ответ</button>`:''}</article>`).join('');root.querySelectorAll('[data-speak]').forEach(b=>b.onclick=()=>speak(chatHistory[Number(b.dataset.speak)].content));root.querySelectorAll('[data-chat-play]').forEach(b=>b.onclick=()=>playAudio(b.dataset.chatPlay));root.scrollTop=root.scrollHeight}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function speak(text){if(!('speechSynthesis'in window)){toast('Озвучивание недоступно.');return}speechSynthesis.cancel();speechSynthesis.speak(new SpeechSynthesisUtterance(text))}
function monthYear(d){return new Intl.DateTimeFormat('ru-RU',{month:'long',year:'numeric'}).format(new Date(d))}
function entityGroups(notes,type){const groups=new Map();for(const n of notes){const objectType=n.entityType||entityType(n.transcript);if(objectType!==type)continue;const family=n.family??familyFrom(n.transcript),key=taskKey(type,family);if(!groups.has(key))groups.set(key,{key,type,family,notes:[]});groups.get(key).notes.push(n)}return[...groups.values()].sort((a,b)=>(a.family??Infinity)-(b.family??Infinity))}
function lastValue(group,key){for(const n of group.notes){const v=n.analysis?.[key];if(v)return v}return null}
function countLabel(count,type){const n=count%100;if(type==='family'){if(n%10===1&&n!==11)return`${count} семья`;if(n%10>=2&&n%10<=4&&(n<12||n>14))return`${count} семьи`;return`${count} семей`}if(n%10===1&&n!==11)return`${count} отводок`;if(n%10>=2&&n%10<=4&&(n<12||n>14))return`${count} отводка`;return`${count} отводков`}
function renderEntities(notes){
  const root=$('entities'),groups=entityGroups(notes,activeType),q=$('search').value.trim().toLowerCase();$('entity-count').textContent=countLabel(groups.filter(g=>g.family!==null).length,activeType);
  const filtered=groups.map(g=>({...g,tasks:taskRows(notes,g.type,g.family),latest:g.notes[0]})).filter(g=>{const open=g.tasks.filter(t=>!t.closed).length;return(activeFilter==='all'||(activeFilter==='open'?open>0:open===0))&&(!q||g.notes.some(n=>`${n.transcript||''} ${JSON.stringify(n.analysis||{})}`.toLowerCase().includes(q)))});
  if(!filtered.length){root.innerHTML=`<div class="empty-state">${groups.length?'В этой категории ничего не найдено.':'Записей пока нет.'}</div>`;return}
  root.innerHTML=filtered.map(g=>{const open=g.tasks.filter(t=>!t.closed),latest=g.latest,facts=[['Матка',lastValue(g,'queen_year')],['Сила',lastValue(g,'strength')],['Корм',lastValue(g,'feed')],['Облёт',lastValue(g,'flight')]].filter(([,v])=>v).map(([k,v])=>`${k}: ${v}`),summary=facts.join(' · ')||latest?.transcript||'Нет расшифровки';const title=g.family?`${g.type==='family'?'Семья':'Отводок'} №${g.family}`:`${g.type==='family'?'Семья':'Отводок'} · номер не указан`;return`<article class="entity-card" data-entity="${escapeHtml(g.key)}"><button class="entity-head" type="button" aria-expanded="false"><span class="entity-number">${g.family?'№'+g.family:'—'}</span><span class="entity-main"><span class="entity-title-line"><span class="entity-title">${title}</span><span class="task-badge ${open.length?'':'none'}">${open.length?`${open.length} задач`:'Без задач'}</span></span><span class="entity-summary">${escapeHtml(summary)}</span>${open.length?`<span class="task-count">${open.length} невыполненных задач</span>`:''}</span><span class="expand-mark" aria-hidden="true">⌄</span></button><div class="entity-details">${facts.length?`<div class="facts">${facts.map(v=>`<span class="fact">${escapeHtml(v)}</span>`).join('')}</div>`:''}${open.length?`<h3 class="subheading">Что необходимо сделать</h3><div class="task-list">${open.map(t=>`<label class="task-row"><input type="checkbox" data-task="${escapeHtml(t.id)}"><span>${escapeHtml(t.text)}</span></label>`).join('')}</div>`:''}<h3 class="subheading">История</h3><div class="history-list">${g.notes.map(n=>`<div class="history-item"><span class="history-date">${fmtDateTime(n.createdAt)}</span>${escapeHtml(n.transcript||'Аудиозапись ждёт расшифровки')}${n.audio?`<button class="history-audio" data-play="${escapeHtml(n.id)}">▶ Аудиозапись</button>`:''}</div>`).join('')}</div></div></article>`}).join('');
  root.querySelectorAll('.entity-head').forEach(button=>button.onclick=()=>{const card=button.closest('.entity-card'),expanded=card.classList.toggle('expanded');button.setAttribute('aria-expanded',String(expanded))});
  root.querySelectorAll('[data-task]').forEach(input=>input.onchange=()=>{const closed=closedTasks();input.checked?closed.add(input.dataset.task):closed.delete(input.dataset.task);writeLocal(CLOSED_KEY,[...closed]);allNotes().then(renderEntities)});
  root.querySelectorAll('[data-play]').forEach(button=>button.onclick=()=>playAudio(button.dataset.play));
}
async function playAudio(id){const n=(await allNotes()).find(x=>x.id===id);if(n?.audio){const audio=new Audio(URL.createObjectURL(n.audio));audio.play()}}
function getMime(){return['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(x=>MediaRecorder.isTypeSupported(x))||''}
function setRecordingUi(kind,active){const button=$(kind==='note'?'record-note':'record-question'),label=$(kind==='note'?'record-label':'question-label'),timer=$(kind==='note'?'record-time':'question-time');button.classList.toggle('recording',active);button.setAttribute('aria-pressed',String(active));label.textContent=active?(kind==='note'?'Идёт запись':'Записывается вопрос'):(kind==='note'?'Записать в журнал':'Спросить журнал');timer.textContent=active?'00:00':''}
function startTimer(kind){startedAt[kind]=Date.now();const id=kind==='note'?'record-time':'question-time';timers[kind]=setInterval(()=>{$(id).textContent=elapsed(Date.now()-startedAt[kind])},250)}
function elapsed(ms){const s=Math.floor(ms/1000);return`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`}
async function record(kind){const active=recorders[kind];if(active&&active.state!=='inactive'){active.stop();return}if(recorders[kind==='note'?'question':'note']?.state==='recording'){toast('Сначала завершите текущую запись.');return}if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){toast('Запись недоступна. Откройте приложение в Chrome и разрешите микрофон.');return}if(kind==='question'&&!navigator.onLine){toast('Для голосового вопроса нужно подключение к интернету.');return}
  try{const stream=await navigator.mediaDevices.getUserMedia({audio:true}),mime=getMime(),recorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined),chunks=[];recorders[kind]=recorder;activeStreams[kind]=stream;recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};setRecordingUi(kind,true);startTimer(kind);
    recorder.onstop=async()=>{clearInterval(timers[kind]);stream.getTracks().forEach(t=>t.stop());recorders[kind]=null;activeStreams[kind]=null;const blob=new Blob(chunks,{type:recorder.mimeType||'audio/webm'});setRecordingUi(kind,false);
      if(kind==='note'){const note={id:crypto.randomUUID(),createdAt:Date.now(),audio:blob,transcript:'',family:null,entityType:'family',analysis:null,status:'pending'};await saveNote(note);appendChat({role:'user',content:'Голосовая заметка сохранена. Ждёт расшифровки.',noteId:note.id,audioNote:true,pending:true});toast('Запись сохранена.');refresh();if(navigator.onLine)processNote(note.id)}
      else{try{const question=normalizeTranscript(await transcribe(blob));appendChat({role:'user',content:question});await askJournal(question)}catch(e){toast(e.message)}}
    };recorder.start();
  }catch{setRecordingUi(kind,false);toast('Не удалось открыть микрофон. Разрешите доступ к микрофону в браузере.')}
}
async function processNote(id){const note=(await allNotes()).find(n=>n.id===id);if(!note||note.status!=='pending'||!navigator.onLine)return false;status('Обрабатываем запись');try{if(!note.transcript){note.originalTranscript=await transcribe(note.audio);note.transcript=normalizeTranscript(note.originalTranscript)}await enrichNote(note);await saveNote(note);updateChatNote(note);appendChat({role:'assistant',content:`Сохранено в ${note.entityType==='nucleus'?'отводок':'семью'}${note.family?` №${note.family}`:''}.`});toast('Заметка добавлена в журнал.');refresh();return true}catch(e){if(note.transcript){note.status='pending';await saveNote(note);updateChatNote(note)}toast(e.message);status('Ожидает обработки',true);return false}}
async function processQueue(){if(!navigator.onLine)return;const notes=await allNotes();for(const n of notes.filter(x=>x.status==='pending')){if(!await processNote(n.id))break}}
async function askJournal(question){if(!question.trim())return;const notes=(await allNotes()).filter(n=>n.transcript).slice(0,180),closed=closedTasks();if(!keyOrder().length){appendChat({role:'assistant',content:'Добавьте API-ключи Groq в настройках.'});return}const context=notes.map(n=>{const analysis={...(n.analysis||{}),tasks:(n.analysis?.tasks||[]).map((text,index)=>({text,status:closed.has(`${n.id}:${index}`)?'выполнено':'открыто'}))};return`Дата: ${new Date(n.createdAt).toLocaleString('ru-RU')}; тип: ${(n.entityType||entityType(n.transcript))==='nucleus'?'отводок':'семья'}; номер: ${n.family??'не определён'}; данные: ${JSON.stringify(analysis)}; запись: ${n.transcript}`}).join('\n');try{const result=await complete(`Вопрос: ${question}\n\nЖурнал пасеки:\n${context||'Записей пока нет.'}\n\nИщи по смыслу, синонимам и близким формулировкам. Для запросов о задачах показывай только задания со статусом «открыто», не упоминай закрытые. Отвечай коротко, но если спрашивают перечень — включи все совпадения, каждое отдельной строкой. Не смешивай семью и отводок даже при одинаковом номере. Используй даты и факты только из журнала. ${notes.length===180?'В контекст включено не более 180 последних записей.':''}`);appendChat({role:'assistant',content:result,speak:true})}catch(e){appendChat({role:'assistant',content:e.message})}}
async function sendText(){const input=$('chat-input'),text=input.value.trim();if(!text)return;input.value='';resizeInput();appendChat({role:'user',content:text});const button=$('send-button');if(button)button.disabled=true;try{await askJournal(text)}finally{if(button)button.disabled=false}}
function resizeInput(){const input=$('chat-input');input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,190)}px`}
async function refresh(){const notes=await allNotes();renderEntities(notes);const pending=notes.filter(n=>n.status==='pending').length;status(!navigator.onLine?'Нет сети':pending?`${pending} в очереди`:'На связи',!navigator.onLine)}
function bind(){
  $('record-note').onclick=()=>record('note');$('record-question').onclick=()=>record('question');
  $('chat-form').onsubmit=async e=>{e.preventDefault();await sendText()};$('chat-input').oninput=resizeInput;$('chat-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendText()}};
  $('search').oninput=()=>allNotes().then(renderEntities);
  document.querySelectorAll('[data-type]').forEach(button=>button.onclick=()=>{activeType=button.dataset.type;document.querySelectorAll('[data-type]').forEach(b=>{const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-selected',String(active))});refresh()});
  document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{activeFilter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b===button));refresh()});
  const dialog=$('settings-dialog');$('open-settings').onclick=()=>{const s=settings();$('api-key-1').value=s.key1;$('api-key-2').value=s.key2;dialog.showModal()};document.querySelector('.settings-close').onclick=()=>dialog.close();
  $('save-settings').onclick=()=>{localStorage.setItem('api-key-1',$('api-key-1').value.trim());localStorage.setItem('api-key-2',$('api-key-2').value.trim());$('settings-status').textContent='Сохранено';setTimeout(()=>{if(dialog.open)dialog.close();$('settings-status').textContent=''},700)};
  window.addEventListener('online',()=>{status('На связи');processQueue()});window.addEventListener('offline',()=>status('Нет сети',true));
}
async function init(){try{db=await openDb();if(navigator.storage?.persist)navigator.storage.persist();bind();renderChat();await refresh();if('serviceWorker'in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});if(navigator.onLine)processQueue()}catch(e){toast('Не удалось открыть журнал: '+e.message)}}
init();
