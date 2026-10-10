/* Isolated Chrome + real IndexedDB; Groq responses are controlled fixtures. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {spawn}=require('node:child_process');const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const chrome=process.env.CHROME_PATH||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
if(!chrome)throw Error('Set CHROME_PATH to a Chromium browser executable.');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'paseka-browser-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer((req,res)=>{
  if(req.url==='/seed'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Seed</title>');return}
  const name=decodeURIComponent(req.url.split('?')[0]),file=path.resolve(root,'.'+(name==='/'?'/index.html':name));
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);res.end();return}
  res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(fs.readFileSync(file));
});
let browser,ws;const pending=new Map(),errors=[];let sequence=0;
async function main(){
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  browser=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
  browser.on('error',error=>{errors.push(error.message)});
  let port;
  for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{await sleep(100)}}
  if(!port)throw Error('Browser did not start: '+errors.join('; '));
  const target=await(await fetch(`http://127.0.0.1:${port}/json/new?about:blank`,{method:'PUT'})).json();
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
  ws.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.id){const task=pending.get(data.id);pending.delete(data.id);data.error?task.reject(Error(data.error.message)):task.resolve(data.result)}else if(data.method==='Runtime.exceptionThrown')errors.push(data.params.exceptionDetails.exception?.description||data.params.exceptionDetails.text)});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,replMode:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
  const until=async(expression,label)=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(50)}throw Error('Timed out: '+label+'\n'+JSON.stringify(await evaluate(`({text:document.body.innerText,toast:document.getElementById('toast')?.textContent,db:typeof db,version:typeof db==='object'?db?.version:null,ready:document.readyState,core:typeof JournalCore,init:typeof init,events:window.__dbEvents})`))+'\n'+errors.join('\n'))};
  await cdp('Runtime.enable');await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__plans=[];window.__requests=[];window.__health=[];window.__confirm=false;window.confirm=()=>window.__confirm;
    window.__dbEvents=[];const openDatabase=indexedDB.open.bind(indexedDB);indexedDB.open=(...args)=>{__dbEvents.push([args,'open']);const request=openDatabase(...args);for(const name of ['success','error','blocked','upgradeneeded'])request.addEventListener(name,()=>__dbEvents.push([args,name]));return request};
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(url,init)=>{
      if(!String(url).startsWith('https://api.groq.com/'))return originalFetch(url,init);
      const payload=JSON.parse(init.body);window.__requests.push(payload);const system=payload.messages[0].content;let reply;
      if(system.startsWith('Оцени приоритет')){
        const data=JSON.parse(payload.messages[1].content);window.__health.push(data);const facts=data.current.facts;
        reply={score:/недостаточно|слабая/.test([facts.feed,facts.queen_status,facts.strength].join(' '))?25:85,reason:'Оценка по текущим кормам, матке и силе семьи.'};
      }else{if(!window.__plans.length)throw Error('Unexpected Groq call: '+system);reply=window.__plans.shift()}
      await new Promise(r=>setTimeout(r,40));
      return new Response(JSON.stringify({choices:[{message:{content:typeof reply==='string'?reply:JSON.stringify(reply)}}]}),{status:200,headers:{'Content-Type':'application/json'}});
    };`});
  await cdp('Page.navigate',{url:base+'/seed'});await until(`document.title==='Seed'`,'seed page');
  await evaluate(`await new Promise((resolve,reject)=>{const r=indexedDB.open('apiary-journal',1);r.onupgradeneeded=()=>r.result.createObjectStore('notes',{keyPath:'id'});r.onsuccess=()=>{const tx=r.result.transaction('notes','readwrite');const s=tx.objectStore('notes');s.put({id:'legacy-1',section:'notes',transcript:'Купить сахар',createdAt:1,status:'done'});s.put({id:'legacy-2',section:'notes',transcript:'Купить рамки',createdAt:2,status:'done'});s.put({id:'family-old',entityType:'family',family:1,transcript:'Семья 1, корма недостаточно',createdAt:Date.now()-86400000,status:'done',analysis:{queen_year:2006,feed:'недостаточно',strength:'weak queen'}});tx.oncomplete=()=>{r.result.close();resolve()};tx.onerror=()=>reject(tx.error)}})`);
  await cdp('Page.navigate',{url:base+'/'});await until(`typeof db!=='undefined'&&db?.version===2&&document.getElementById('entities')?.textContent.includes('Семья №1')`,'v2 migration');
  assert.deepEqual(await evaluate(`(await allNotes()).filter(J.isEntry).sort((a,b)=>a.createdAt-b.createdAt).map(n=>n.entryNumber)`),[1,2]);
  assert.equal(await evaluate(`document.querySelector('[data-filter="clear"]')===null`),true);
  assert.equal(await evaluate(`document.getElementById('entities').textContent.includes('weak queen')`),false);
  await evaluate(`localStorage.setItem('api-key-1','test-key');await setActiveType('treatment')`);
  async function record(text,plan){
    await evaluate(`__plans.push(...${JSON.stringify(Array.isArray(plan)?plan:[plan])});document.getElementById('record-note').click();document.getElementById('choose-text').click();document.getElementById('input-text').value=${JSON.stringify(text)};document.getElementById('input-send').click()`);
    await until(`!document.getElementById('input-dialog').open&&processingNotes.size===0&&__plans.length===0`,'record '+text);
  }
  await record('5 обработка, обработал пчёл мавриком',{action:'create',number:5,text:'Обработал пчёл мавриком.'});
  assert.deepEqual(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='treatment').map(n=>n.entryNumber)`),[5]);
  await record('По обработке номер 5, не только мавриком, но ещё серной кислотой',{action:'append',number:5,text:'Также серной кислотой.'});
  const treatments=await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='treatment')`);
  assert.equal(treatments.length,1);assert.match(treatments[0].transcript,/мавриком[\s\S]*серной кислотой/);
  assert.equal(await evaluate(`__requests.filter(r=>r.messages[0].content.startsWith('Ты разбираешь')).length`),2);
  // Retry the same completed command: IndexedDB must not apply it twice.
  await evaluate(`await processNote((await allNotes()).find(n=>J.isCommand(n)&&n.transcript.startsWith('По обработке')).id)`);
  assert.equal((await evaluate(`(await allNotes()).find(n=>J.isEntry(n)&&n.section==='treatment').transcript`)).match(/серной/g).length,1);
  await record('Измени обработку 99',{action:'replace',number:99,text:'Неизвестно'});
  assert.equal(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='treatment').length`),1);
  await record('Удали все записи',{action:'delete_all',number:null,text:''});
  assert.equal(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='treatment').length`),1);
  await evaluate(`await approveEntryDeletion((await allNotes()).find(n=>n.status==='approval').id)`);
  assert.equal(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='treatment').length`),1,'cancelled confirmation must preserve entries');
  await evaluate(`window.__confirm=true;await approveEntryDeletion((await allNotes()).find(n=>n.status==='approval').id)`);
  assert.equal(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='treatment').length`),0);
  assert.equal(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='notes').length`),2);
  await record('Новая обработка',{action:'create',number:null,text:'Новая обработка.'});
  assert.equal(await evaluate(`(await allNotes()).find(n=>J.isEntry(n)&&n.section==='treatment').entryNumber`),6,'deleted numbers cannot renumber surviving/new cards');
  // Offline text is a queued command, not a fabricated entry.
  await evaluate(`Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false});document.getElementById('record-note').click();document.getElementById('choose-text').click();document.getElementById('input-text').value='Обработка 6, дополнение без сети';document.getElementById('input-send').click()`);
  await until(`!document.getElementById('input-dialog').open`,'offline save');
  assert.equal(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='treatment').length`),1);
  await evaluate(`__plans.push({action:'append',number:6,text:'Дополнение без сети.'});Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});window.dispatchEvent(new Event('online'))`);
  await until(`(await allNotes()).some(n=>J.isEntry(n)&&n.transcript.includes('Дополнение без сети'))`,'offline replay');
  // Queries include only real entries of the selected section, with stable numbers.
  await evaluate(`__plans.push('Только лечение');await askJournal('Что записано?','treatment')`);
  const query=await evaluate(`__requests.at(-1).messages[1].content`);assert.ok(!query.includes('Купить сахар'));assert.ok(!query.includes('Семья 1, корма недостаточно'));assert.ok(query.includes('номер записи: 6'));
  await evaluate(`await setActiveType('notes')`);
  await record('Заметку номер 2 дополни покупкой гвоздей',{action:'append',number:2,text:'Купить гвозди.'});
  assert.match(await evaluate(`(await allNotes()).find(n=>n.id==='legacy-2').transcript`),/рамки[\s\S]*гвозди/);
  await record('Привет, я пошутил',{action:'noop',message:'Ничего не изменено.'});
  await record('Неразборчивая команда','not valid JSON');
  assert.equal(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='notes').length`),2);
  assert.equal(await evaluate(`(await allNotes()).some(n=>J.isCommand(n)&&n.error&&n.status==='pending')`),true);
  await evaluate(`await cancelEntryCommand((await allNotes()).find(n=>J.isCommand(n)&&n.error).id)`);
  await record('Что купить?', [{action:'question',text:'Что купить?'},'Сахар, рамки и гвозди.']);
  assert.equal(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='notes').length`),2);
  assert.ok((await evaluate(`document.getElementById('entities').textContent`)).includes('Сахар, рамки и гвозди.'));
  await evaluate(`await setActiveType('treatment');Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>false})`);
  await record('Обработка 7, первая часть',[]);
  await record('Дополни обработку 7 второй частью',[]);
  await evaluate(`__plans.push({action:'create',number:7,text:'Первая часть.'},{action:'append',number:7,text:'Вторая часть.'});Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>true});window.dispatchEvent(new Event('online'))`);
  await until(`(await allNotes()).some(n=>J.isEntry(n)&&n.section==='treatment'&&n.entryNumber===7&&n.transcript.includes('Вторая часть'))`,'ordered offline commands');
  assert.equal(await evaluate(`(await allNotes()).filter(n=>J.isEntry(n)&&n.section==='treatment'&&n.entryNumber===7).length`),1);
  await evaluate(`await setActiveType('family');await runHealthQueue()`);
  await until(`document.querySelector('.health-critical')!==null`,'initial red health');
  await record('Семья 1: заменил матку, корма достаточно, сильная семья',`family_number: 1\nentity_type: family\nqueen_year: 2026\nqueen_status: нормальная\nqueen_replaced: yes\nstrength: сильная\nfeed: достаточно\nframe_count: 10\ntasks: нет\ncompleted_tasks: нет\ncondition: нет`);
  await until(`document.querySelector('.health-good')!==null`,'updated green health');
  const snapshot=await evaluate(`__health.at(-1).current.facts`);assert.equal(snapshot.feed,'достаточно');assert.equal(snapshot.queen_year,2026);assert.equal(snapshot.queen_status,'нормальная');assert.equal(snapshot.strength,'сильная');
  const shot=await cdp('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(profile,'mobile-family.png'),Buffer.from(shot.data,'base64'));
  // Manual edits trigger another assessment of the current facts.
  await evaluate(`showEntityActions('family|1');document.getElementById('edit-entity').click()`);
  await until(`document.getElementById('entity-edit-dialog').open`,'manual editor');
  await evaluate(`document.getElementById('edit-feed').value='недостаточно';document.getElementById('entity-edit-form').requestSubmit()`);
  await until(`document.querySelector('.health-critical')!==null`,'manual red health');
  // Numbers survive deletion and reload/migration.
  await evaluate(`await deleteNotes(['legacy-1'])`);
  await cdp('Page.reload');await until(`typeof db!=='undefined'&&db?.version===2&&document.getElementById('entities')?.textContent.includes('Семья №1')`,'reload');
  assert.equal(await evaluate(`(await allNotes()).find(n=>n.id==='legacy-2').entryNumber`),2);
  assert.equal(await evaluate(`document.documentElement.scrollWidth<=window.innerWidth`),true,'mobile layout overflow');
  assert.deepEqual(errors,[]);
  console.log('PASS: migration, stable numbers, create/append/delete, confirmation, isolation, offline replay, idempotency, current-state health, manual edits and mobile layout.');
  console.log('Screenshot: '+path.join(profile,'mobile-family.png'));
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{if(ws)ws.close();if(browser)browser.kill();await new Promise(resolve=>server.close(resolve))});
