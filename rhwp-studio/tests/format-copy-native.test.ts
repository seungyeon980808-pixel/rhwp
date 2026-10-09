import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/live-native-loader.ts';
const { HwpDocument } = await import('../../pkg/rhwp.js');
const { InputHandler } = await import('../src/engine/input-handler.ts');
const { editCommands } = await import('../src/command/commands/edit.ts');
const { CommandDispatcher } = await import('../src/command/dispatcher.ts');
const { CommandRegistry } = await import('../src/command/registry.ts');

for (const withPath of [false, true]) test(`copied body font (${withPath ? 'path' : 'legacy flat'} target)` + ' is applied into a cell through checkpoint resume and persists on reopen', () => {
 const doc=HwpDocument.createEmpty();let reopened;
 try {
  doc.createBlankDocument();doc.insertText(0,0,0,'source');doc.splitParagraph(0,0,6);doc.createTable(0,1,0,1,1);doc.insertTextInCell(0,1,0,0,0,0,'target');
  doc.applyCharFormat(0,0,0,6,JSON.stringify({bold:true,fontSize:1400}));
  const parsed=new Set(['getCharPropertiesAt','getParaPropertiesAt','getCellCharPropertiesAtByPath']);
  const wasm=new Proxy(doc,{get(t,k){const val=Reflect.get(t,k);return typeof val==='function'?(...args:any[])=>{const r=val.apply(t,args);return parsed.has(String(k))?JSON.parse(r):r;}:val;}});
  const input:any=Object.create(InputHandler.prototype);
  let selection:any=null, live=true;const requests:string[]=[];const commands:any[]=[];
  Object.assign(input,{wasm,formatCopyState:null,cursor:{isInCellSelectionMode:()=>false,getPosition:()=>({sectionIndex:0,paragraphIndex:0,charOffset:0})},
   getSelection:()=>selection,getCharProperties:()=>JSON.parse(doc.getCharPropertiesAt(0,0,0)),getParaProperties:()=>JSON.parse(doc.getParaPropertiesAt(0,0)),
   focusTextarea:()=>{},executeOperation:(desc:any)=>{commands.push(desc.command);return desc.command.execute(wasm);},
   applyParaPropsToRange:(_start:any,_end:any,props:any)=>doc.applyParaFormatInCell(0,1,0,0,0,JSON.stringify(props)),
  });
  const registry=new CommandRegistry();for(const command of editCommands)registry.register(command);
  const context=()=>({hasDocument:true,hasCopiedFormat:input.hasCopiedFormat(),hasSelection:Boolean(selection),inCellSelectionMode:false,isLiveCollaboration:live,canRequestDocumentEdit:true,isFormMode:false});
  const dispatcher=new CommandDispatcher(registry,{getContext:context,getInputHandler:()=>input,eventBus:{emit:()=>{}},requestDocumentEdit:(id:string)=>requests.push(id)} as any,{emit:()=>{}} as any);
  assert.equal(dispatcher.dispatch('edit:format-copy'),true);assert.equal(input.formatCopyState.charProps.bold,true);
  const start={sectionIndex:0,paragraphIndex:0,charOffset:0,parentParaIndex:1,controlIndex:0,cellIndex:0,cellParaIndex:0,...(withPath ? {cellPath:[{controlIndex:0,cellIndex:0,cellParaIndex:0}]} : {})};selection={start,end:{...start,charOffset:6}};
  assert.equal(dispatcher.dispatch('edit:format-copy'),false);assert.deepEqual(requests,['edit:format-paste']);
  live=false;assert.equal(dispatcher.resumePendingDocumentCommand('edit:format-paste'),true);
  assert.equal(JSON.parse(doc.getCellCharPropertiesAt(0,1,0,0,0,0)).bold,true);
  commands[0].undo(wasm);assert.equal(JSON.parse(doc.getCellCharPropertiesAt(0,1,0,0,0,0)).bold,false);
  commands[0].execute(wasm);assert.equal(JSON.parse(doc.getCellCharPropertiesAt(0,1,0,0,0,0)).bold,true);
  reopened=new HwpDocument(doc.exportHwp());assert.equal(JSON.parse(reopened.getCellCharPropertiesAt(0,1,0,0,0,0)).bold,true);
 } finally {doc.free();reopened?.free();}
});
