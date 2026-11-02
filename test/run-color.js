var C=require('../client/js/color.js');
var pass=0,fail=0;
function ok(c,l,x){ if(c){pass++;console.log('PASS  '+l);} else {fail++;console.log('FAIL  '+l+(x?'  '+x:''));} }
function near(a,b,t,l){ ok(Math.abs(a-b)<=t, l+' ('+(Math.round(a*1000)/1000)+')'); }

console.log('--- WCAG reference values (WebAIM published) ---');
near(C.contrastRatio([255,255,255],[0,0,0]),21,0.001,'white/black = 21');
near(C.contrastRatio(C.fromHex('#777777'),[255,255,255]),4.478,0.01,'#777777 on white = 4.48');
near(C.contrastRatio(C.fromHex('#0000FF'),[255,255,255]),8.592,0.01,'#0000FF on white = 8.59');
near(C.contrastRatio(C.fromHex('#FF0000'),[255,255,255]),3.998,0.01,'#FF0000 on white = 4.00');
near(C.contrastRatio([255,255,255],[255,255,255]),1,0.001,'white/white = 1');

console.log('\n--- Delta E ---');
near(C.deltaE2000([0,0,0],[0,0,0]),0,0.0001,'identical = 0');
near(C.deltaE2000([255,255,255],[0,0,0]),100,0.5,'white/black ~100');
ok(C.deltaE2000(C.fromHex('#FF0000'),C.fromHex('#FE0202'))<2,'near colours = tiny dE');
ok(C.deltaE2000(C.fromHex('#FF0000'),C.fromHex('#00FF00'))>50,'far colours = large dE');

console.log('\n--- compositing ---');
ok(C.toHex(C.composite(C.fromHex('#FF00FF'),0.5,'normal',[255,255,255]))==='#FF80FF','50% magenta over white = #FF80FF');
ok(C.toHex(C.composite([0,0,0],0.5,'normal',[255,255,255]))==='#808080','50% black over white = #808080');
ok(C.toHex(C.composite([0,0,0],1,'normal',[255,255,255]))==='#000000','opaque = untouched');
ok(C.toHex(C.composite([0,0,0],0,'normal',[255,255,255]))==='#FFFFFF','zero alpha = backdrop');
ok(C.toHex(C.composite(C.fromHex('#FF0000'),0.25,'normal',C.fromHex('#0000FF')))==='#4000BF','25% red over blue');

console.log('\n--- blend modes (W3C reference behaviour) ---');
ok(C.toHex(C.blend('multiply',[255,255,255],[128,128,128]))==='#808080','multiply over white = source');
ok(C.toHex(C.blend('multiply',[0,0,0],[128,128,128]))==='#000000','multiply over black = black');
ok(C.toHex(C.blend('screen',[255,255,255],[128,128,128]))==='#FFFFFF','screen over white = white');
ok(C.toHex(C.blend('screen',[0,0,0],[128,128,128]))==='#808080','screen over black = source');
ok(C.toHex(C.blend('darken',C.fromHex('#FF8000'),C.fromHex('#00FF80')))==='#008000','darken = per-channel min');
ok(C.toHex(C.blend('lighten',C.fromHex('#FF8000'),C.fromHex('#00FF80')))==='#FFFF80','lighten = per-channel max');
ok(C.toHex(C.blend('difference',[255,255,255],[255,255,255]))==='#000000','difference of equals = black');
ok(C.toHex(C.blend('normal',[255,255,255],C.fromHex('#123456')))==='#123456','normal = source');
var lum=C.blend('luminosity',[128,128,128],C.fromHex('#FF0000'));
ok(Math.abs(0.3*lum[0]+0.59*lum[1]+0.11*lum[2]-0.3*255)<2,'luminosity transfers source luma');
var hue=C.blend('hue',[128,128,128],C.fromHex('#FF0000'));
ok(Math.abs(0.3*hue[0]+0.59*hue[1]+0.11*hue[2]-128)<2,'hue preserves backdrop luma');
var clean=true;
for(var i=0;i<3000;i++){
  var b=[~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)];
  var s=[~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)];
  var modes=['multiply','screen','overlay','darken','lighten','colordodge','colorburn','hardlight','softlight','difference','exclusion','hue','saturation','colorblend','luminosity'];
  var r=C.blend(modes[~~(Math.random()*modes.length)],b,s);
  for(var k=0;k<3;k++) if(!(r[k]>=0&&r[k]<=255)||isNaN(r[k])) clean=false;
}
ok(clean,'3000 random blends stay in range, no NaN');

console.log('\n--- backdrop stack (host payload shape) ---');
// text 60% white on a card 80% teal on paper
var stack=[{rgb:C.fromHex('#0E8C82'),alpha:0.8,blend:'normal'}];
var card=C.renderedColour({rgb:C.fromHex('#0E8C82'),alpha:0.8,blend:'normal'},[],null);
var text=C.renderedColour({rgb:[255,255,255],alpha:0.6,blend:'normal'},stack,null);
console.log('   card renders '+C.toHex(card)+', text renders '+C.toHex(text));
ok(C.toHex(card)==='#3EA39B','80% teal on paper composites correctly');
ok(C.contrastRatio(text,card) < C.contrastRatio([255,255,255],C.fromHex('#0E8C82')),'stack exposes the worse real ratio');
ok(C.toHex(C.renderedColour({rgb:[10,20,30],alpha:1,blend:'normal'},[],null))==='#0A141E','opaque layer passes through');

console.log('\n--- a container both colours sit in ---');
/*
  Black text on #808080, both inside a group at 65%, over white paper.

  Illustrator draws the group into its own buffer and lays that buffer down
  once, so the text renders #595959 on #ACACAC — 3.08:1, a failure. There are
  two ways to get this wrong and both of them report a pass:

    65% charged to the text as well as the background  #3C3C3C  4.86  "pass"
    65% cancelled from the text entirely               #000000  9.25  "pass"
*/
var grouped=C.renderedPair(
  {rgb:[0,0,0],alpha:0.65,alphaOverBackground:1,blend:'normal'},
  {rgb:[128,128,128],alpha:0.65,alphaOverBackground:1,blend:'normal'},
  [], {alpha:0.65,blend:'normal'}, null);
console.log('   text renders '+C.toHex(grouped.fg)+' on '+C.toHex(grouped.bg));
ok(C.toHex(grouped.fg)==='#595959','the shared group fades the text over the PAPER, not over the background');
ok(C.toHex(grouped.bg)==='#ACACAC','and fades the background the same way');
ok(C.contrastRatio(grouped.fg,grouped.bg).toFixed(2)==='3.09','which is the 3.08 Illustrator draws, not 4.86 or 9.25');

// No shared container: must reduce exactly to the old one-layer-at-a-time maths.
var apart=C.renderedPair(
  {rgb:[0,0,0],alpha:0.5,blend:'normal'},
  {rgb:[255,255,255],alpha:1,blend:'normal'},
  [], null, null);
ok(C.toHex(apart.fg)===C.toHex(C.composite([0,0,0],0.5,'normal',[255,255,255])),
   'with nothing shared it matches compositing each layer separately');
ok(C.toHex(apart.bg)==='#FFFFFF','and leaves the background alone');

/*
  Backdrops sit BEHIND the shared container, so the container is composited ONTO
  them — they are not dragged through it. White text on a black card, both in a
  group at 50%, over a red page: the group's buffer goes down on red, so the text
  renders #FF8080. Compositing the group onto bare paper instead loses the red
  entirely and returns #FFFFFF.
*/
var behind=C.renderedPair(
  {rgb:[255,255,255],alpha:1,alphaOverBackground:1,blend:'normal'},
  {rgb:[0,0,0],alpha:1,alphaOverBackground:1,blend:'normal'},
  [{rgb:[255,0,0],alpha:1,blend:'normal'}], {alpha:0.5,blend:'normal'}, null);
ok(C.toHex(behind.fg)==='#FF8080','a 50% group is composited onto the backdrop behind it, not onto paper');
ok(C.toHex(behind.bg)==='#800000','and so is the card inside it');

// An older host sends no `shared` at all. It must degrade, not throw or NaN.
var legacy=C.renderedPair(
  {rgb:[0,0,0],alpha:0.5,blend:'normal'},
  {rgb:[255,255,255],alpha:1,blend:'normal'},
  [], undefined, null);
ok(C.toHex(legacy.fg)==='#808080','a payload with no shared layer still renders');
ok(C.unsharedAlphaOf({alpha:0.4})===0.4,'and falls back to the total alpha');
ok(C.unsharedAlphaOf({alpha:0.4,alphaOverBackground:0.8})===0.8,'preferring the unshared one when sent');
ok(C.unsharedAlphaOf(null)===1,'a missing layer is fully opaque');

console.log('\n--- a blend mode on a shared container ---');
/*
  De-sharing the alpha but not the blend was worse than de-sharing neither.

  #555555 text on a #A0A0A0 card, both inside a group set to Multiply, over
  white paper: Multiply against white is the identity, so it renders exactly as
  authored — 2.85:1, a failure. Applying the group's Multiply to the text at the
  inner step AND again at the shared step made it #353535 and reported 4.69,
  green, "passes AA".
*/
var mul=C.renderedPair(
  {rgb:C.fromHex('#555555'),alpha:1,alphaOverBackground:1,blend:'multiply',blendOverBackground:'normal'},
  {rgb:C.fromHex('#A0A0A0'),alpha:1,alphaOverBackground:1,blend:'multiply',blendOverBackground:'normal'},
  [], {alpha:1,blend:'multiply'}, null);
ok(C.toHex(mul.fg)==='#555555','a shared Multiply is not also charged to the text');
ok(C.contrastRatio(mul.fg,mul.bg).toFixed(2)==='2.85','so it reads 2.85 and fails, not 4.69 and passes');

// The item's OWN blend still applies, and only once.
var ownMul=C.renderedPair(
  {rgb:C.fromHex('#555555'),alpha:1,alphaOverBackground:1,blend:'multiply',blendOverBackground:'multiply'},
  {rgb:C.fromHex('#A0A0A0'),alpha:1,alphaOverBackground:1,blend:'normal',blendOverBackground:'normal'},
  [], {alpha:1,blend:'normal'}, null);
ok(C.toHex(ownMul.fg)===C.toHex(C.blend('multiply',C.fromHex('#A0A0A0'),C.fromHex('#555555'))),
   'an item\'s own blend is still applied, against the colour behind it');

/*
  Every mode, checked against the physics rather than against the code.

  The group buffer holds the text exactly as authored (#555555 — the item itself
  is Normal). Illustrator then lays that buffer onto the page ONCE with the
  group's mode, so the rendered text must equal blend(mode, paper, #555555).
  Applying the mode inside the group as well gives blend(mode, card, #555555)
  put through the mode a second time, which is a different colour for every mode
  where blending is not idempotent.
*/
var doubled=[];
['multiply','screen','overlay','darken','lighten','colordodge','colorburn','hardlight',
 'softlight','difference','exclusion','hue','saturation','luminosity'].forEach(function(mode){
  var r=C.renderedPair(
    {rgb:C.fromHex('#555555'),alpha:1,alphaOverBackground:1,blend:mode,blendOverBackground:'normal'},
    {rgb:C.fromHex('#A0A0A0'),alpha:1,alphaOverBackground:1,blend:mode,blendOverBackground:'normal'},
    [], {alpha:1,blend:mode}, null);
  var once=C.toHex(C.blend(mode,C.PAPER,C.fromHex('#555555')));
  if (C.toHex(r.fg)!==once) doubled.push(mode+': '+C.toHex(r.fg)+' should be '+once);
});
ok(doubled.length===0,'every shared blend is applied exactly once, over the page',
   doubled.join(', '));

console.log('\n--- writing a fix back through the same model ---');
/*
  The inverse of renderedPair. Solving only the item's own layer, against the
  already-rendered background, was wrong twice over: on the worked example above
  it offered "#404040 · 4.56:1", wrote #060606, and rendered #5D5D5D — 2.90:1,
  WORSE than the 3.08 it started from.
*/
var gFg={rgb:[0,0,0],alpha:0.65,alphaOverBackground:1,blend:'normal',blendOverBackground:'normal'};
var gBg={rgb:[128,128,128],alpha:0.65,alphaOverBackground:1,blend:'normal',blendOverBackground:'normal'};
var gShared={alpha:0.65,blend:'normal'};

ok(C.solveForPair(C.fromHex('#404040'),'fg',gFg,gBg,[],gShared,null).reason==='unreachable',
   'a target no fill can reach through a 65% group is refused, not approximated');

var reachable=C.solveForPair(C.fromHex('#FFFFFF'),'fg',gFg,gBg,[],gShared,null);
ok(reachable.ok,'a reachable one is solved');
var applied=C.renderedPair({rgb:reachable.rgb,alpha:0.65,alphaOverBackground:1,blend:'normal',
                            blendOverBackground:'normal'},gBg,[],gShared,null);
ok(C.toHex(applied.fg)==='#FFFFFF','and writing it renders exactly the colour promised');

/*
  Fuzz: whatever solveForPair accepts must render as asked. A solver that is
  merely close is a solver that quietly moves artwork the wrong way.
*/
var solveOff=0, solveTried=0;
for(var i=0;i<3000;i++){
  var sh={alpha:Math.random(),blend:'normal'};
  var f={rgb:[~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)],
         alphaOverBackground:Math.random(),blend:'normal',blendOverBackground:'normal'};
  var b={rgb:[~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)],
         alphaOverBackground:Math.random(),blend:'normal',blendOverBackground:'normal'};
  var want=[~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)];
  var got=C.solveForPair(want,'fg',f,b,[],sh,null);
  if(!got.ok) continue;
  solveTried++;
  var out=C.renderedPair({rgb:got.rgb,alphaOverBackground:f.alphaOverBackground,
                          blend:'normal',blendOverBackground:'normal'},b,[],sh,null);
  for(var k=0;k<3;k++) if(Math.abs(out.fg[k]-want[k])>1) solveOff++;
}
ok(solveOff===0,'3000 solve->render round-trips land within 1/255 ('+solveTried+' solvable)',
   String(solveOff));

/*
  The degenerate shapes. An older host sends none of the new fields; a broken one
  sends nonsense. Neither may produce a colour outside 0-255, a NaN, or an
  exception — a NaN reaching a swatch renders as transparent and reads as a
  measurement the panel simply declined to show.
*/
var shapes=[
 ['no fields at all', {rgb:[0,0,0]}, {rgb:[255,255,255]}, undefined],
 ['null shared', {rgb:[0,0,0],alpha:0.5,blend:'normal'}, {rgb:[255,255,255],alpha:1,blend:'normal'}, null],
 ['null background', {rgb:[0,0,0],alpha:1,blend:'normal'}, null, {alpha:0.5,blend:'normal'}],
 ['null foreground', null, {rgb:[9,9,9],alpha:1,blend:'normal'}, {alpha:1,blend:'normal'}],
 ['rgb null on both sides', {rgb:null}, {rgb:null}, {alpha:0.3,blend:'multiply'}],
 ['a container at zero opacity', {rgb:[0,0,0]}, {rgb:[255,255,255]}, {alpha:0,blend:'normal'}],
 ['nonsense in the shared layer', {rgb:[0,0,0]}, {rgb:[255,255,255]}, {alpha:'x',blend:42}]
];
var degenerate=[];
shapes.forEach(function(row){
  var name=row[0];
  try{
    var out=C.renderedPair(row[1],row[2],[],row[3],null);
    var all=out.fg.concat(out.bg);
    for(var i=0;i<all.length;i++){
      if(!isFinite(all[i])||all[i]<0||all[i]>255){ degenerate.push(name); break; }
    }
    var solved=C.solveForPair([128,128,128],'fg',row[1],row[2],[],row[3],null);
    if(solved.ok){
      for(var j=0;j<solved.rgb.length;j++) if(!isFinite(solved.rgb[j])) degenerate.push(name+' (solve)');
    }
  }catch(e){ degenerate.push(name+' threw: '+e.message); }
});
ok(degenerate.length===0,'degenerate payloads give finite colours, not NaN and not an exception',
   degenerate.join('; '));

/*
  And the reduction, exactly. With nothing shared, the new two-stage model must
  be bit-identical to the one-layer-at-a-time maths it replaced — otherwise every
  reading in every document without a shared group has silently moved.
*/
var drift=0;
for(var d=0;d<2000;d++){
  var rnd=function(){return [~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)];};
  var stack=Math.random()<0.5?[{rgb:rnd(),alpha:Math.random(),blend:'normal'}]:[];
  var dbg={rgb:rnd(),alpha:Math.random(),blend:'normal'};
  var dfg={rgb:rnd(),alpha:Math.random(),blend:'normal'};
  var got=C.renderedPair(dfg,dbg,stack,null,null);
  var wantBg=C.renderedColour(dbg,stack,null);
  var wantFg=C.composite(dfg.rgb,dfg.alpha,'normal',wantBg);
  if(C.toHex(got.bg)!==C.toHex(wantBg)||C.toHex(got.fg)!==C.toHex(wantFg)) drift++;
}
ok(drift===0,'2000 unshared readings are bit-identical to the maths this replaced',
   String(drift)+' diverged');

/*
  chooseFixTarget asks for ONE suggestion and compares its deltaE to decide which
  side to recolour. suggest() now re-sorts its output by ratio, so prove that a
  one-item request still returns the nearest candidate rather than an arbitrary one.
*/
var nearestBroken=0;
for(var n=0;n<300;n++){
  var pick=function(){return [~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)];};
  var a=pick(), b=pick();
  var one=C.suggest(a,b,4.5,1), many=C.suggest(a,b,4.5,5);
  if(!one.length||!many.length) continue;
  var lowest=many[0].deltaE;
  for(var m=1;m<many.length;m++) if(many[m].deltaE<lowest) lowest=many[m].deltaE;
  if(Math.abs(one[0].deltaE-lowest)>1e-9) nearestBroken++;
}
ok(nearestBroken===0,'a one-item request is still the nearest colour, after the re-sort',
   String(nearestBroken));

console.log('\n--- the WCAG rung ladder ---');
/*
  The complaint this replaced: from a 1.3:1 pair the strip offered five shades
  all landing near 3:1, because it aimed at whichever single threshold the
  current level and size implied. Reaching 4.5 or 7 meant opening Settings and
  changing the target level first.
*/
var ladderFg=C.fromHex('#8FA5B8'), ladderBg=C.fromHex('#B8C6D4');
var startRatio=C.contrastRatio(ladderFg,ladderBg);
var ladder=C.suggestLadder(ladderFg,ladderBg,startRatio);
console.log('   from '+startRatio.toFixed(2)+':1 -> '+
  ladder.map(function(r){return r.label+' '+(r.ok?r.hex+' ('+r.ratio.toFixed(2)+')':'unreachable');}).join(', '));

ok(ladder.length===3,'three rungs, one per WCAG threshold',String(ladder.length));
ok(ladder[0].label==='3:1'&&ladder[1].label==='4.5:1'&&ladder[2].label==='7:1',
   'in ascending order: 3, 4.5, 7');
ok(ladder.every(function(r){return !r.ok||r.ratio>=r.target;}),
   'every rung actually reaches the threshold it names');
/*
  The whole point: one click from 1.46 to 7.11, without changing any setting.
*/
ok(ladder[2].ok&&ladder[2].ratio>=7,'AAA is reachable in one step from a 1.46:1 pair',
   ladder[2].ok?ladder[2].ratio.toFixed(2):'unreachable');
ok(ladder[0].deltaE<ladder[2].deltaE,
   'and the lower rungs are the smaller visual moves');
ok(ladder.every(function(r){return !!r.who&&!!r.sc;}),
   'each rung names its audience and its success criterion');
ok(/1\.4\.6/.test(ladder[2].sc),'AAA body text cites SC 1.4.6',ladder[2].sc);
ok(/1\.4\.11/.test(ladder[0].sc),'and the 3:1 rung cites 1.4.11',ladder[0].sc);

// A rung already cleared is reported as met, not offered as a change.
var metLadder=C.suggestLadder(C.fromHex('#FFFFFF'),C.fromHex('#0E8C82'),4.12);
ok(metLadder[0].met===true,'a rung the artwork already clears is marked met');
ok(metLadder[1].met===false,'and one it does not is still on offer');

/*
  Unreachable rungs are REPORTED, not dropped. Even pure white on #888888 is
  only 3.9:1 and pure black only 5.3:1, so no shade of anything reaches 7 —
  and "there is nothing here" is a more useful answer than a shorter list.
*/
var stuck=C.suggestLadder(C.fromHex('#787878'),C.fromHex('#888888'),1.25);
ok(stuck.length===3,'the ladder is always three rungs long',String(stuck.length));
ok(stuck[2].ok===false,'an unreachable rung says so instead of vanishing');
ok(stuck[2].rgb===null,'and offers no colour to apply');
ok(stuck[0].ok===true&&stuck[1].ok===true,'while the reachable ones still work');

console.log('\n--- the level the user asked for ---');
/*
  gradeFor answers "what does this reach", which is a different question from
  "does it clear my target". The old scan list asked the first and reported the
  second, so 4.54:1 body text came back as "all pass" with AAA selected. The
  scan is gone; the distinction is not, and anything that grades must use
  meetsLevel.
*/
ok(C.gradeFor(4.54,'normal')==='AA','4.54 body text reaches AA');
ok(C.meetsLevel(4.54,'AA','normal')===true,'and clears an AA target');
ok(C.meetsLevel(4.54,'AAA','normal')===false,'but does NOT clear an AAA one');
ok(C.meetsLevel(7.0,'AAA','normal')===true,'7.0 clears AAA');
ok(C.meetsLevel(3.0,'AAA','graphic')===true,'icons need 3 whatever the level says');

console.log('\n--- inverse solve ---');
var s1=C.solveAuthoredFill([128,128,128],0.5,'normal',[255,255,255]);
ok(s1.ok,'mid grey at 50% over white is solvable');
ok(C.toHex(C.composite(s1.rgb,0.5,'normal',[255,255,255]))==='#808080','round-trip exact');
ok(C.solveAuthoredFill([0,0,0],0.5,'normal',[255,255,255]).reason==='unreachable','black at 50% over white rejected');
ok(C.solveAuthoredFill([255,255,255],0.5,'multiply',[255,255,255]).reason==='blend','blend mode refused');
ok(C.solveAuthoredFill([255,255,255],0.01,'normal',[255,255,255]).reason==='invisible','near-zero alpha refused');
var rt=true,rej=0;
for(var i=0;i<3000;i++){
  var t=[~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)];
  var bd=[~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)];
  var a=0.05+Math.random()*0.95;
  var sol=C.solveAuthoredFill(t,a,'normal',bd);
  if(!sol.ok){rej++;continue;}
  var back=C.composite(sol.rgb,a,'normal',bd);
  for(var k=0;k<3;k++) if(Math.abs(back[k]-t[k])>1) rt=false;
}
ok(rt,'3000 solve->composite round-trips within 1/255 ('+rej+' correctly rejected)');

console.log('\n--- grading + matrix ---');
ok(C.gradeFor(4.6,'normal')==='AA','4.6 normal = AA');
ok(C.gradeFor(7.1,'normal')==='AAA','7.1 normal = AAA');
ok(C.gradeFor(3.2,'normal')==='Fail','3.2 normal = Fail');
ok(C.gradeFor(3.2,'large')==='AA','3.2 large = AA');
// Non-text contrast is 1.4.11, which exists only at AA. Reporting 'Pass' put a
// second vocabulary into the grade, and the panel printed "passes Pass".
ok(C.gradeFor(3.2,'graphic')==='AA','3.2 graphic = AA');
ok(C.gradeFor(2.9,'graphic')==='Fail','2.9 graphic = Fail');
ok(C.requiredRatio('AA','normal')===4.5 && C.requiredRatio('AAA','normal')===7,'required ratios');
var m=C.matrix(4.12);
ok(m.normal.aa===false && m.large.aa===true && m.graphic.aa===true && m.graphic.aaa===null,'matrix cells for 4.12');

console.log('\n--- display rounding must never flatter the artwork ---');
// toFixed rounds to nearest, so 4.4996 printed "4.50" beside a Fail verdict.
ok(C.displayRatio(4.4996)==='4.49','4.4996 truncates to 4.49, not 4.50');
ok(C.displayRatio(4.5)==='4.50','an exact 4.5 still reads 4.50');
ok(C.displayRatio(21)==='21.00','21 formats with both places');
ok(C.displayRatio(1.0)==='1.00','1 formats with both places');
var roundClean=true;
for(var i=0;i<5000;i++){
  var r=1+Math.random()*20;
  var shown=parseFloat(C.displayRatio(r));
  // The printed number must always be reachable: never above the real ratio.
  if(shown>r+1e-9) roundClean=false;
  if(r-shown>=0.01) roundClean=false;
}
ok(roundClean,'5000 ratios: printed value never exceeds the real one');

console.log('\n--- readable ink ---');
ok(C.toHex(C.readableInk([255,255,255]))==='#000000','black ink on white');
ok(C.toHex(C.readableInk([0,0,0]))==='#FFFFFF','white ink on black');
var inkClean=true;
for(var i=0;i<2000;i++){
  var bgc=[~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)];
  var ink=C.readableInk(bgc);
  var other=(ink[0]===0)?[255,255,255]:[0,0,0];
  if(C.contrastRatio(ink,bgc)<C.contrastRatio(other,bgc)) inkClean=false;
}
ok(inkClean,'2000 backgrounds: always picks the higher-contrast ink');

console.log('\n--- achromatic bases stay achromatic ---');
// White has no hue, so offsetting its saturation invented pink "fixes".
var whiteFixes=C.suggest([255,255,255],[255,255,255],4.5,5);
var greyish=true;
for(var i=0;i<whiteFixes.length;i++){
  var c=whiteFixes[i].rgb;
  if(Math.max(c[0],c[1],c[2])-Math.min(c[0],c[1],c[2])>2) greyish=false;
}
ok(whiteFixes.length>0,'white on white still gets suggestions');
ok(greyish,'and every one of them is neutral, not tinted');
var tealFixes=C.suggest(C.fromHex('#0E8C82'),[255,255,255],4.5,5);
ok(tealFixes.length===5,'a hued base still explores saturation variants');

console.log('\n--- suggestions ---');
var sug=C.suggest(C.fromHex('#0E8C82'),[255,255,255],4.5,5);
var allPass=true,ramps=true;
for(var i=0;i<sug.length;i++){
  if(sug[i].ratio<4.5) allPass=false;
  if(i>0&&sug[i].ratio<sug[i-1].ratio) ramps=false;
  console.log('   '+sug[i].hex+'  '+sug[i].ratio.toFixed(2)+':1  dE '+sug[i].deltaE.toFixed(1)+'  '+sug[i].shift);
}
ok(sug.length===5,'returns 5 swatches','got '+sug.length);
ok(allPass,'all clear the target');
/*
  The strip is documented, in the panel and the README, as "leftmost smallest
  change, rightmost highest contrast". Selection is by perceptual distance, but
  the saturation offsets made that non-monotonic in ratio — a real strip read
  4.52 · 4.62 · 5.26 · 5.00 · 5.62, so the promise on screen was simply untrue.
*/
ok(ramps,'and are shown as the contrast ramp the panel promises',
   sug.map(function(x){return x.ratio.toFixed(2);}).join(' '));
ok(sug[0].deltaE===Math.min.apply(null,sug.map(function(x){return x.deltaE;})),
   'with the smallest visual change still first');
ok(C.suggest(C.fromHex('#808080'),C.fromHex('#7F7F7F'),7,5).length===0,'impossible target returns none');

console.log('\n--- hex + hsb ---');
ok(C.toHex([255,0,128])==='#FF0080','toHex');
ok(C.fromHex('fff').join(',')==='255,255,255','shorthand hex');
ok(C.fromHex('nope')===null,'rejects garbage');
var hsbOk=true;
for(var n=0;n<500;n++){var c=[~~(Math.random()*256),~~(Math.random()*256),~~(Math.random()*256)];var bk=C.hsbToRgb(C.rgbToHsb(c));if(Math.abs(bk[0]-c[0])>1||Math.abs(bk[1]-c[1])>1||Math.abs(bk[2]-c[2])>1)hsbOk=false;}
ok(hsbOk,'HSB round-trip, 500 random colours');

console.log('\n--- a gradient is graded along its length, not at its stops ---');
/*
  1.10.0 graded a gradient by its stops alone. Two ways that flatters artwork:

  Text whose luminance sits BETWEEN two stops: the ramp passes through the
  text's own luminance and the text vanishes there. #767676 on white to black
  read 4.54:1 against its stops, an AA pass, and is 1.00:1 at about 54%.

  No crossing at all: Illustrator mixes in gamma-encoded RGB and luminance is
  convex in it, so the middle of a red to green ramp is darker than either end.
  Black text read 5.25:1 against the stops, an AA pass, and 3.94:1 at worst.
*/
var gStops=[{rgb:[255,255,255],alpha:1},{rgb:[0,0,0],alpha:1}];
var gPath=C.asPath(C.gradientSamples(gStops).map(function(s){return s.rgb;}));
var grey=[0x76,0x76,0x76];
ok(C.contrastAgainstAll(grey,gStops.map(function(s){return s.rgb;})).toFixed(2)==='4.54',
   'the stops alone still read 4.54, so the regression this guards is real');
ok(C.contrastAgainstAll(grey,gPath)===1,'along the path #767676 on white to black is exactly 1.00');
ok(C.meetsLevel(C.contrastAgainstAll(grey,gPath),'AA','normal')===false,'and fails, as it must');
var gSpan=C.contrastRange(grey,gPath);
ok(gSpan&&gSpan.worst===1&&gSpan.best>4.6,'the range reports the crossing as its worst',JSON.stringify(gSpan));

var rg=C.asPath(C.gradientSamples([{rgb:[255,0,0]},{rgb:[0,255,0]}]).map(function(s){return s.rgb;}));
var rgWorst=C.contrastAgainstAll([0,0,0],rg);
ok(C.contrastAgainstAll([0,0,0],[[255,0,0],[0,255,0]]).toFixed(2)==='5.25','black on red to green: 5.25 at the stops');
ok(rgWorst<4.0&&rgWorst>3.9,'but 3.94 in the darker middle, with no crossing anywhere',rgWorst.toFixed(3));
ok(C.meetsLevel(rgWorst,'AA','normal')===false,'which turns an AA pass into the failure it is');

// Text lighter than every stop: the path must agree with the stops exactly.
ok(C.contrastAgainstAll([255,255,255],gPath)===C.contrastAgainstAll([255,255,255],[[255,255,255],[0,0,0]]),
   'text outside the ramp reads the same as before');
var plainList=[[255,255,255],[0,0,0]];
ok(C.contrastAgainstAll(grey,plainList).toFixed(2)==='4.54','an unmarked list is still a set, not a path');

console.log('\n--- large text depends on the medium ---');
/*
  WCAG's points are CSS points: 18pt is 24px and 14pt is 18.66px. Illustrator
  web documents count one pixel as one point, so on screen the thresholds are
  24 and 18.66 bold. In print a point is a point.
*/
ok(C.sizeClassFor(18,false,'screen')==='normal','18 on screen is body text, not large');
ok(C.sizeClassFor(23.9,false,'screen')==='normal','23.9 on screen is still body text');
ok(C.sizeClassFor(24,false,'screen')==='large','24 on screen is large');
ok(C.sizeClassFor(18.66,true,'screen')==='large','18.66 bold on screen is large');
ok(C.sizeClassFor(18,true,'screen')==='normal','18 bold on screen is not');
ok(C.sizeClassFor(18,false,'print')==='large','18 in print is large');
ok(C.sizeClassFor(14,true,'print')==='large','14 bold in print is large');
ok(C.sizeClassFor(13.9,true,'print')==='normal','13.9 bold in print is not');
ok(C.sizeClassFor(0,false,'screen')==='normal'&&C.sizeClassFor(NaN,true,'print')==='normal',
   'an unknown size is graded as body text, the strict side');
ok(C.sizeClassFor(30,false,'nonsense')==='large'&&C.sizeClassFor(20,false,'nonsense')==='normal',
   'an unknown medium falls back to the screen rule, the stricter of the two');

console.log('\n--- gradient sampling ---');
var two=C.gradientSamples(gStops);
ok(two.length===C.GRADIENT_STEPS+1,'two stops sample the full density',String(two.length));
ok(two[0].rgb[0]===255&&two[two.length-1].rgb[0]===0,'and include both ends exactly');
var many=[];for(var gi=0;gi<24;gi++)many.push({rgb:[gi*10,gi*10,gi*10],alpha:1,rampPoint:gi});
ok(C.gradientSamples(many).length<=257,'a 24 stop gradient stays inside the sample budget',String(C.gradientSamples(many).length));
var shuffled=[{rgb:[0,0,0],rampPoint:100},{rgb:[255,255,255],rampPoint:0}];
var ordered=C.gradientSamples(shuffled);
ok(ordered[0].rgb[0]===255&&ordered[ordered.length-1].rgb[0]===0,
   'stops are walked in ramp order, not in the order they arrived');
var fade=C.gradientSamples([{rgb:[0,0,0],alpha:1},{rgb:[0,0,0],alpha:0}]);
ok(Math.abs(fade[16].alpha-0.5)<0.001,'stop opacity is interpolated along with colour',String(fade[16].alpha));
ok(C.gradientSamples([{rgb:[9,9,9]}]).length===1,'a single stop is just that colour');
ok(C.gradientSamples([]).length===0&&C.gradientSamples(null).length===0,'no stops, no samples, no throw');

console.log('\n'+pass+' passed, '+fail+' failed');
if(fail) process.exitCode=1;
