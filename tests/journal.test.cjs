const test=require('node:test');
const assert=require('node:assert/strict');
const J=require('../journal-core.js');
const command=(transcript,section='treatment')=>({id:'cmd',recordKind:'command',section,transcript,status:'pending',createdAt:10});
const entry=(number,section='treatment',text='Маврик')=>({id:`${section}-${number}`,recordKind:'entry',section,entryNumber:number,transcript:text,status:'done',createdAt:1});
test('spoken entry numbers exclude colony numbers, doses and years',()=>{
  for(const text of ['5 обработка, обработал пчёл','по обработке номер 5 хочу добавить','пятая обработка','обработку №5 дополни'])assert.equal(J.numberInCommand(text,'treatment'),5);
  assert.equal(J.numberInCommand('Обработал семью 5, матка 2026 года, 10 мл','treatment'),null);
  assert.equal(J.numberInCommand('Обработка 5 мая, всей пасеки','treatment'),null);
  assert.equal(J.numberInCommand('Обработка 5 семей','treatment'),null);
  assert.equal(J.numberInCommand('заметка номер два','notes'),2);
});
test('create explicit number 5, then append to that same identity',()=>{
  const first=J.applyPlan(command('5 обработка, маврик'),{action:'create',number:5,text:'Маврик'},[],0,20,'t-5');
  assert.equal(first.puts[0].entryNumber,5);assert.equal(first.counter,5);
  const next=J.applyPlan(command('По обработке номер 5 — ещё кислота'),{action:'append',number:5,text:'Также кислота'},[first.puts[0]],5,30,'unused');
  assert.equal(next.puts[0].id,'t-5');assert.equal(next.puts[0].entryNumber,5);
  assert.equal(next.puts[0].transcript,'Маврик\n\nТакже кислота');assert.equal(next.counter,5);
});
test('repeated create number appends instead of duplicating',()=>{
  assert.equal(J.validatePlan({action:'create',number:5,text:'Добавление'},command('Обработка 5, добавление'),[entry(5)]).action,'append');
});
test('unknown update, wrong model number and cross-section target cannot modify a record',()=>{
  assert.equal(J.validatePlan({action:'append',number:5,text:'Добавление'},command('Обработка 5'),[entry(5,'notes')]).action,'clarify');
  assert.throws(()=>J.validatePlan({action:'replace',number:6,text:'x'},command('Обработка 5'),[entry(6)]),/другой номер/);
});
test('delete command cannot be saved as content if model misclassifies it',()=>{
  assert.equal(J.validatePlan({action:'create',number:null,text:'Удали все записи'},command('Удали все записи'),[]).action,'clarify');
  assert.equal(J.validatePlan({action:'create',number:null,text:'Нужно удалить сорняки'},command('Нужно удалить сорняки','notes'),[]).action,'create');
});
test('deletion requires confirmation and affects only current section',()=>{
  const entries=[entry(5),entry(1),entry(5,'notes')],plan={action:'delete_all',number:null};
  assert.throws(()=>J.applyPlan(command('удали все записи'),plan,entries,5,20,'unused'),/изменился/);
  const cmd={...command('удали все записи'),deletionConfirmed:true,approvedTargets:entries.filter(n=>n.section==='treatment').map(J.revision)};
  const result=J.applyPlan(cmd,plan,entries,5,20,'unused');assert.deepEqual(result.deletes,['treatment-5','treatment-1']);
  const changed=[{...entries[0],transcript:'Отредактировано'},...entries.slice(1)];
  assert.throws(()=>J.applyPlan(cmd,plan,changed,5,20,'unused'),/изменился/);
});
test('retry after successful commit is idempotent and numbering never reuses deleted maxima',()=>{
  const done=J.applyPlan(command('новая обработка'),{action:'create',text:'Текст'},[],8,20,'new');
  assert.equal(done.puts[0].entryNumber,9);
  assert.deepEqual(J.applyPlan(done.puts[1],{action:'create',text:'Текст'},done.puts,9,30,'duplicate').puts,[]);
});
test('newer facts supersede old facts without carrying forward a generic old alarm',()=>{
  const old={id:'old',createdAt:1,status:'done',analysis:{feed:'недостаточно',strength:'слабая',condition:'всё плохо',queen_year:2006}};
  const now={id:'now',createdAt:2,status:'done',analysis:{feed:'достаточно',strength:'сильная'}};
  const snap=J.currentSnapshot([old,now]);assert.equal(snap.facts.feed,'достаточно');assert.equal(snap.facts.strength,'сильная');assert.equal(snap.facts.queen_year,2006);assert.equal(snap.facts.condition,undefined);
});
test('queen replacement clears the previous queen data unless explicitly supplied anew',()=>{
  const old={id:'old',createdAt:1,analysis:{queen_year:2006,queen_status:'слабая'}};
  const now={id:'now',createdAt:2,analysis:{queen_replaced:true,queen_status:'нормальная'}};
  assert.deepEqual(J.currentSnapshot([old,now]).facts,{queen_status:'нормальная'});
});
test('legacy weak queen is translated and not treated as colony strength',()=>{
  const snap=J.currentSnapshot([{id:'n',createdAt:1,analysis:{strength:'weak queen'}}]);
  assert.equal(snap.facts.queen_status,'слабая матка');assert.equal(snap.facts.strength,undefined);
});
test('manual clears do not resurrect older fields; frames and year alone are insufficient',()=>{
  const snap=J.currentSnapshot([{id:'n',createdAt:2,analysis:{manual_cleared:['feed'],frame_count:10,queen_year:2026}},{id:'o',createdAt:1,analysis:{feed:'недостаточно'}}]);
  assert.equal(snap.facts.feed,undefined);assert.equal(J.assessmentInput(snap).assessable,false);
});
test('invalid score is rejected; neutral, red, yellow and green are distinct',()=>{
  for(const score of [0,101,'90',NaN])assert.throws(()=>J.validateHealth({score,reason:'test'}));
  assert.deepEqual([null,20,60,85].map(J.healthBand),['unknown','critical','attention','good']);
});
