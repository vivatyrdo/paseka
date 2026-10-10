/* Shared journal rules. No network, DOM or storage access. */
(function(root){
  'use strict';
  const simpleSections=new Set(['notes','treatment']);
  const fields=['queen_year','queen_status','feed','strength','frame_count','condition'];
  const isEntry=n=>simpleSections.has(n.section)&&n.recordKind!=='command';
  const isCommand=n=>n.recordKind==='command';
  function numberInCommand(text,section){
    const unit=section==='treatment'?'(?:обработк[а-я]*|лечени[а-я]*)':'(?:заметк[а-я]*|запис[ьиь][а-я]*)';
    const words={один:1,одна:1,перв:1,два:2,две:2,втор:2,три:3,трет:3,четыре:4,четверт:4,пять:5,пят:5,шесть:6,шест:6,семь:7,седьм:7,восемь:8,восьм:8,девять:9,девят:9,десять:10,десят:10};
    const token='(?:\\d+|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|(?:перв|втор|трет|четверт|пят|шест|седьм|восьм|девят|десят)[а-я]*)';
    const t=String(text).toLowerCase().replaceAll('ё','е');
    const patterns=[new RegExp(`(?:^|[^а-я0-9])${unit}\\s*(?:номер|№)?\\s*(${token})(?=$|[^а-я0-9])`,'g'),new RegExp(`(?:^|[^а-я0-9])(${token})(?:-?[а-я]{1,3})?\\s+${unit}(?=$|[^а-я0-9])`,'g')];
    const found=new Set();
    for(const re of patterns)for(const m of t.matchAll(re)){
      const after=t.slice(m.index+m[0].length);
      if(!/номер|№/.test(m[0])&&/^\s*(?:январ|феврал|марта|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр|сем(?:ь|ей|и)|уль[ея]|отвод|мл|дней|дня|числа)/.test(after))continue;
      const value=/^\d+$/.test(m[1])?Number(m[1]):words[m[1]]??Object.entries(words).find(([key])=>m[1].startsWith(key))?.[1];
      if(Number.isSafeInteger(value)&&value>0&&value<=999999)found.add(value);
    }
    return found.size===1?[...found][0]:null;
  }
  function parseJson(text){
    const clean=String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    try{return JSON.parse(clean)}catch{throw new Error('Не удалось разобрать команду. Уточните её и повторите.')}
  }
  function validatePlan(raw,command,entries){
    const actions=['create','append','replace','delete','delete_all','clarify','noop','question'];
    if(!raw||!actions.includes(raw.action))throw new Error('Сервис вернул неизвестное действие. Команда сохранена.');
    const plan={action:raw.action,number:raw.number??null,text:typeof raw.text==='string'?raw.text.trim():'',message:typeof raw.message==='string'?raw.message.trim():''};
    if(plan.number!==null&&(!Number.isInteger(plan.number)||plan.number<1||plan.number>999999))throw new Error('Не удалось определить номер записи.');
    const explicit=numberInCommand(command.transcript,command.section);
    if(explicit!==null){
      if(plan.number!==null&&plan.number!==explicit)throw new Error(`В команде указан №${explicit}, а сервис выбрал другой номер. Уточните команду.`);
      plan.number=explicit;
      if(plan.action==='delete_all'){plan.action='clarify';plan.message='Указан номер записи и удаление всех записей одновременно. Уточните, что удалить.'}
    }
    const scoped=entries.filter(n=>isEntry(n)&&n.section===command.section);
    const target=scoped.find(n=>n.entryNumber===plan.number);
    if(['create','append','replace'].includes(plan.action)&&!plan.text)throw new Error('В команде нет текста для сохранения.');
    // A repeated number addresses the existing entry; it never allocates another card.
    if(plan.action==='create'&&target)plan.action='append';
    if(['append','replace','delete'].includes(plan.action)&&!target){plan.action='clarify';plan.message=plan.number?`Запись №${plan.number} не найдена. Укажите существующий номер или попросите создать новую.`:'Укажите номер записи, которую нужно изменить.'}
    // Never save a destructive instruction as an ordinary note on classifier failure.
    const deletionRequest=/(?:удал(?:и|ить)|сотр(?:и|еть)|очист(?:и|ить))\s+(?:(?:все|всё|эту|эти|мою|мои|всю|весь|пожалуйста)\s+)*(?:запис[а-я]*|заметк[а-я]*|обработк[а-я]*|журнал|раздел|баз[ау])|(?:удали|сотри|очисти)\s+(?:все|всё)\s*[.!?]*$/i.test(command.transcript);
    if(deletionRequest&&['create','append','replace'].includes(plan.action)){
      plan.action='clarify';plan.message='Это команда удаления. Уточните номер записи или скажите «удалить все записи». Ничего не удалено.';
    }
    return plan;
  }
  function previewTargets(plan,entries,section){
    return entries.filter(n=>isEntry(n)&&n.section===section&&(plan.action==='delete_all'||n.entryNumber===plan.number));
  }
  function revision(n){return JSON.stringify([n.id,n.transcript,n.updatedAt||0,n.entryNumber])}
  function applyPlan(command,plan,entries,counter,now,newId){
    if(command.status==='applied'||command.status==='cancelled')return{puts:[],deletes:[],counter,receipt:command.receipt};
    const validated=validatePlan(plan,command,entries);
    if(['clarify','noop','question'].includes(validated.action))throw new Error('Команда не содержит подтверждённого изменения.');
    const targets=previewTargets(validated,entries,command.section);
    if(['delete','delete_all'].includes(validated.action)){
      const approved=command.approvedTargets||[];
      if(!command.deletionConfirmed||!targets.length||JSON.stringify(targets.map(revision).sort())!==JSON.stringify(approved.slice().sort()))throw new Error('Список записей изменился. Проверьте удаление ещё раз.');
      return{puts:[{...command,status:'applied',receipt:`Удалено записей: ${targets.length}.`,appliedAt:now}],deletes:targets.map(n=>n.id),counter,receipt:`Удалено записей: ${targets.length}.`};
    }
    const maximum=Math.max(counter||0,0,...entries.filter(n=>isEntry(n)&&n.section===command.section).map(n=>n.entryNumber||0));
    let entry=targets[0],number=validated.number;
    if(validated.action==='create'){
      number=number||maximum+1;
      entry={id:newId,section:command.section,recordKind:'entry',entryNumber:number,createdAt:command.createdAt,updatedAt:now,audio:command.audio||null,transcript:validated.text,status:'done',family:null,analysis:null};
    }else{
      entry={...entry,updatedAt:now,transcript:validated.action==='append'?`${entry.transcript}\n\n${validated.text}`:validated.text,status:'done',revisions:[...(entry.revisions||[]),{text:entry.transcript,changedAt:now}]};
      number=entry.entryNumber;
    }
    const receipt=`${validated.action==='create'?'Создана':'Обновлена'} запись №${number}.`;
    return{puts:[entry,{...command,audio:null,status:'applied',receipt,resultEntryId:entry.id,appliedAt:now}],deletes:[],counter:Math.max(maximum,number),receipt};
  }
  function normalizeFact(value){
    if(typeof value!=='string')return value??null;
    const map={'weak queen':'слабая матка','weak':'слабая','normal':'нормальная','strong':'сильная','sufficient':'достаточно','insufficient':'недостаточно','good':'хорошее','poor':'плохое','absent':'отсутствует','present':'есть'};
    const v=value.trim();return map[v.toLowerCase()]||v||null;
  }
  function currentSnapshot(notes){
    const rows=[...notes].filter(n=>n.status!=='review'&&!isCommand(n)).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id));
    const result={facts:{},sources:{},lastInspection:null};
    for(const field of fields){
      const sources=field==='condition'?rows.filter(n=>n.analysis).slice(0,1):rows;
      for(const n of sources){
        const a=n.analysis;if(!a)continue;
        if(a.manual_cleared?.includes(field))break;
        if(a.queen_replaced&&['queen_year','queen_status'].includes(field)&&!a[field])break;
        let value=normalizeFact(a[field]);
        // Repair legacy extraction which put the queen's condition under colony strength.
        if(field==='queen_status'&&!value&&/queen|матк/i.test(a.strength||''))value=normalizeFact(a.strength);
        if(field==='strength'&&/queen|матк/i.test(a.strength||''))value=null;
        if(value!==null&&value!==undefined&&value!==''){
          result.facts[field]=value;result.sources[field]=n.factDates?.[field]||n.factsUpdatedAt||n.createdAt;break;
        }
      }
    }
    result.lastInspection=rows.find(n=>n.analysis)?.createdAt||null;
    return result;
  }
  function assessmentInput(snapshot){
    // Year and frame count alone cannot establish that a colony is healthy.
    const assessable=['queen_status','feed','strength','condition'].some(key=>snapshot.facts[key]);
    return{...snapshot,assessable};
  }
  function validateHealth(raw){
    if(!raw||!(raw.score===null||Number.isInteger(raw.score)&&raw.score>=1&&raw.score<=100)||typeof raw.reason!=='string'||!raw.reason.trim())throw new Error('Не удалось оценить состояние по записи.');
    return{score:raw.score,reason:raw.reason.trim()};
  }
  function healthBand(score){return score==null?'unknown':score<40?'critical':score<70?'attention':'good'}
  const api={isEntry,isCommand,numberInCommand,parseJson,validatePlan,previewTargets,revision,applyPlan,normalizeFact,currentSnapshot,assessmentInput,validateHealth,healthBand};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else root.JournalCore=api;
})(globalThis);
