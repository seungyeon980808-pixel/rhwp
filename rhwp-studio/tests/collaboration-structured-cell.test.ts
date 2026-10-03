import test from 'node:test';
import assert from 'node:assert/strict';
import {readStructuredCell,validateStructuredOps,structuredPosition,applyStructuredCellOps} from '../src/embed/collaboration-structured-cell.ts';
const address={section:0,paragraph:1,control:2,cell:3};
const outerPath=[{controlIdx:2,cellIdx:3,cellParaIdx:0}];
const nestedPath=[...outerPath,{controlIdx:0,cellIdx:4,cellParaIdx:0}];
function fixture(){return {supported:true,nested:true,topology:[{rows:1,cols:2}],blocks:[
  {path:outerPath,paragraphs:[{text:'제목\ufffc',paragraph:{}}]},
  {path:nestedPath,paragraphs:[{text:'가나다',paragraph:{}},{text:'다음',paragraph:{}}]},
]};}
test('nested cells are canonical text inside one outer region; protected markers cannot be deleted',()=>{
  const wasm:any={getCollaborationStructuredCell:fixture};
  const read=readStructuredCell(wasm,address)!;
  assert.equal(read.text,'제목\ufffc\u2029가나다\n다음');
  assert.equal(validateStructuredOps(read.text,[{type:'delete',offset:2,count:1}]),null);
  assert.equal(validateStructuredOps(read.text,[{type:'delete',offset:3,count:1}]),null);
  assert.equal(validateStructuredOps(read.text,[{type:'insert',offset:4,text:'\u2029'}]),null);
  assert.equal(validateStructuredOps(read.text,[{type:'insert',offset:5,text:'\n새문단'}]),'제목\ufffc\u2029가\n새문단나다\n다음');
});
test('nested cursor uses ancestor region and canonical UTF16 offset',()=>{
  const point=structuredPosition({getCollaborationStructuredCell:fixture} as any,{sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:0,cellIndex:4,cellParaIndex:1,charOffset:1,cellPath:[
    {controlIndex:2,cellIndex:3,cellParaIndex:0},{controlIndex:0,cellIndex:4,cellParaIndex:1}]});
  assert.deepEqual(point,{id:'c:0:1:2:3',offset:9,text:'제목\ufffc\u2029가나다\n다음'});
});
test('invalid multi-op batch is rejected before any native mutation',()=>{
  let calls=0;const wasm:any={getCollaborationStructuredCell:fixture,insertTextInCellByPath(){calls++;}};
  assert.equal(applyStructuredCellOps(wasm,address,'제목\ufffc\u2029가나다\n다음',[
    {type:'insert',offset:4,text:'검증'}, {type:'delete',offset:2,count:1}]),null);
  assert.equal(calls,0);
});

test('structured permission protects nested object even for an unrestricted host', async()=>{
  const {PromptSpacePolicy}=await import('../src/embed/prompt-space-policy.ts');
  const policy=new PromptSpacePolicy({memberId:null,spaces:[],texts:[]});
  const wasm:any={getCollaborationStructuredCell:fixture};
  const outer={sectionIndex:0,paragraphIndex:0,parentParaIndex:1,controlIndex:2,cellIndex:3,cellParaIndex:0,charOffset:2};
  assert.equal(policy.allows(wasm,outer,outer),true);
  assert.equal(policy.allows(wasm,outer,{...outer,charOffset:3}),false,'cannot erase native table marker');
  assert.equal(policy.allows(wasm,outer,outer,1),false,'Delete cannot erase table object');
  assert.equal(policy.allows(wasm,{...outer,charOffset:3},{...outer,charOffset:3},-1),false,'Backspace cannot erase table object');
});

test('canonical nested focus restores exact native path and scalar offset after paragraphs and emoji', async()=>{
  const {structuredNativePosition}=await import('../src/embed/collaboration-structured-cell.ts');
  const value=fixture(); value.blocks[1]!.paragraphs[0]!.text='가😀나다';
  const wasm:any={getCollaborationStructuredCell:()=>value};
  const text=readStructuredCell(wasm,address)!.text;
  const offset=text.indexOf('다음')+1;
  const native=structuredNativePosition(wasm,address,offset)!;
  assert.deepEqual(native,{sectionIndex:0,paragraphIndex:1,parentParaIndex:1,controlIndex:2,cellIndex:3,
    cellParaIndex:0,charOffset:1,cellPath:[{controlIndex:2,cellIndex:3,cellParaIndex:0},{controlIndex:0,cellIndex:4,cellParaIndex:1}]});
  assert.equal(structuredPosition(wasm,native)?.offset,offset);
  const emojiEnd=text.indexOf('😀')+2;
  const emojiPosition=structuredNativePosition(wasm,address,emojiEnd)!;
  assert.equal(emojiPosition.charOffset,2);
  assert.equal(emojiPosition.cellPath?.length,2);
  assert.equal(structuredPosition(wasm,emojiPosition)?.offset,emojiEnd);
  assert.equal(structuredNativePosition(wasm,address,emojiEnd-1),null,'reject split surrogate');
  assert.equal(structuredNativePosition(wasm,address,-1),null);
  assert.equal(structuredNativePosition(wasm,address,text.length+1),null);
});

test('remote Enter and deletion remap both selection ends inside an inner table with emoji', async()=>{
  const {structuredNativePosition,structuredPositionRemapper}=await import('../src/embed/collaboration-structured-cell.ts');
  const {remapCollaborationTextPosition}=await import('../src/embed/collaboration-text-position.ts');
  const before=fixture(); before.blocks[1]!.paragraphs=[{text:'가😀나다',paragraph:{}}];
  const oldReader:any={getCollaborationStructuredCell:()=>before};
  const anchor=structuredNativePosition(oldReader,address,7)!; // after 가😀
  const focus=structuredNativePosition(oldReader,address,9)!; // end of inner paragraph
  const after=structuredClone(before);after.blocks[1]!.paragraphs=[{text:'가😀',paragraph:{}},{text:'새나다',paragraph:{}}];
  const insert={type:'insert' as const,offset:7,text:'\n새'};
  const forward=structuredPositionRemapper(address,before,after,[insert]);
  const change={nativeAddress:'c:0:1:2:3',before:readStructuredCell(oldReader,address)!.text,ops:[insert],remapPosition:forward};
  const movedAnchor=remapCollaborationTextPosition(anchor,change),movedFocus=remapCollaborationTextPosition(focus,change);
  assert.equal(movedAnchor.cellPath?.at(-1)?.cellParaIndex,1);
  assert.equal(movedAnchor.charOffset,1);
  assert.equal(movedFocus.cellPath?.at(-1)?.cellParaIndex,1);
  assert.equal(movedFocus.charOffset,3);
  const reverse=structuredPositionRemapper(address,after,before,[{type:'delete',offset:7,count:2}]);
  assert.deepEqual(reverse(movedAnchor),anchor);
  assert.deepEqual(reverse(movedFocus),focus);
  const unrelated={...anchor,sectionIndex:3};
  assert.equal(forward(unrelated),unrelated);
});

test('remote outer paragraph split keeps viewer inside the same nested cell', async()=>{
  const {structuredNativePosition,structuredPositionRemapper}=await import('../src/embed/collaboration-structured-cell.ts');
  const before=fixture(),after=structuredClone(before);
  const reader:any={getCollaborationStructuredCell:()=>before};
  const cursor=structuredNativePosition(reader,address,5)!;
  after.blocks[0]!.paragraphs=[{text:'제목',paragraph:{}},{text:'\ufffc',paragraph:{}}];
  after.blocks[1]!.path[0]!.cellParaIdx=1;
  const remap=structuredPositionRemapper(address,before,after,[{type:'insert',offset:2,text:'\n'}]);
  const moved=remap(cursor);
  assert.equal(moved.cellPath?.[0]?.cellParaIndex,1);
  assert.equal(moved.cellPath?.[1]?.cellIndex,4);
  assert.equal(moved.charOffset,1);
  assert.equal(structuredPosition({getCollaborationStructuredCell:()=>after} as any,moved)?.offset,6);
});
