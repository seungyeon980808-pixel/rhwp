import type { CellPathSegment, CharProperties, DocumentPosition, ParaProperties } from '../core/types.ts';
import type { CollaborationManifestRegionV1, CollaborationOpV1, CollaborationRunV1 } from './collaboration-live-contract.ts';
import type { CollaborationRegionV1 } from './collaboration-text-contract.ts';
import { decodeCollaborationParagraph, isCollaborationParagraph } from './collaboration-text-validation.ts';

/** These wire markers preserve cell boundaries and native object anchors. */
export const STRUCTURED_BOUNDARY = '\u2029';
export const STRUCTURED_OBJECT = '\ufffc';
export type StructuredAddress = Readonly<{section:number;paragraph:number;control:number;cell:number}>;
export type StructuredBlock = Readonly<{path:readonly CellPathSegment[];paragraphs:readonly {text:string;paragraph:ParaProperties;charRunStarts?:readonly number[]}[]}>;
export type StructuredCell = Readonly<{supported:boolean;nested:boolean;blocks:readonly StructuredBlock[];topology:readonly unknown[]}>;
export interface StructuredCellReader {
  isStructuredCollaborationCell?(section:number,parent:number,control:number,cell:number):boolean;
  getCollaborationStructuredCell?(section:number,parent:number,control:number,cell:number):StructuredCell;
}
export interface StructuredCellWasm extends StructuredCellReader {
  insertTextInCellByPath(section:number,parent:number,path:string,offset:number,text:string):unknown;
  deleteTextInCellByPath(section:number,parent:number,path:string,offset:number,count:number):unknown;
  splitParagraphInCellByPath(section:number,parent:number,path:string,offset:number):unknown;
  mergeParagraphInCellByPath(section:number,parent:number,path:string):unknown;
  getCellCharPropertiesAtByPath(section:number,parent:number,path:string,offset:number):CharProperties;
  applyCharFormatInCellByPath(section:number,parent:number,path:string,start:number,end:number,properties:string):unknown;
}
export function structuredAddress(id:string):StructuredAddress|null {
  const match=/^c:(\d+):(\d+):(\d+):(\d+)$/u.exec(id);
  return match?{section:Number(match[1]),paragraph:Number(match[2]),control:Number(match[3]),cell:Number(match[4])}:null;
}
function encode(text:string):string|null {
  return /[\u0000-\u0009\u000b-\u001f\u007f\u2029]/u.test(text)?null:text.replaceAll('\n','\v');
}
export function readStructuredCell(wasm:StructuredCellReader,address:StructuredAddress): (StructuredCell & {text:string})|null {
  const value=wasm.getCollaborationStructuredCell?.(address.section,address.paragraph,address.control,address.cell);
  if(!value?.supported||!value.nested||!value.blocks.length) return null;
  const blocks=value.blocks.map(b=>b.paragraphs.map(p=>encode(p.text)));
  if(blocks.some(b=>!b.length||b.some(p=>p===null))) return null;
  const text=blocks.map(b=>b.join('\n')).join(STRUCTURED_BOUNDARY);
  return text.length<=20_000?{...value,text}:null;
}
function scalar(text:string,offset:number):number|null {
  if(offset>0&&offset<text.length&&/[\ud800-\udbff]/u.test(text[offset-1]!)&&/[\udc00-\udfff]/u.test(text[offset]!)) return null;
  return [...text.slice(0,offset)].length;
}
function point(text:string,offset:number) {
  const prefix=text.slice(0,offset),block=prefix.split(STRUCTURED_BOUNDARY).length-1;
  const inBlock=prefix.slice(prefix.lastIndexOf(STRUCTURED_BOUNDARY)+1),paragraph=inBlock.split('\n').length-1;
  const paragraphStart=offset-inBlock.slice(inBlock.lastIndexOf('\n')+1).length;
  return {block,paragraph,offset:scalar(text.slice(paragraphStart),offset-paragraphStart)};
}
function path(block:StructuredBlock,paragraph:number):string {
  return JSON.stringify(block.path.map((p,i)=>({controlIndex:p.controlIdx,cellIndex:p.cellIdx,cellParaIndex:i===block.path.length-1?paragraph:p.cellParaIdx})));
}
/** Validate complete batch before changing native content. Objects and table topology are immutable. */
export function validateStructuredOps(text:string,ops:readonly CollaborationOpV1[]):string|null {
  for(const op of ops) {
    if(!Number.isSafeInteger(op.offset)||op.offset<0||op.offset>text.length||scalar(text,op.offset)===null) return null;
    if(op.type==='insert') {
      if(/[\u2029\ufffc]/u.test(op.text)||!op.text.split('\n').every(isCollaborationParagraph)) return null;
      text=text.slice(0,op.offset)+op.text+text.slice(op.offset);
    }else {
      if(!Number.isSafeInteger(op.count)||op.count<0||op.offset+op.count>text.length||scalar(text,op.offset+op.count)===null) return null;
      if(/[\u2029\ufffc]/u.test(text.slice(op.offset,op.offset+op.count))) return null;
      if(op.type==='format') {if(op.scope!=='character') return null;}
      else text=text.slice(0,op.offset)+text.slice(op.offset+op.count);
    }
    if(text.length>20_000) return null;
  }
  return text;
}
export function applyStructuredCellOps(wasm:StructuredCellWasm,address:StructuredAddress,expectedText:string,ops:readonly CollaborationOpV1[]):string|null {
  const expected=validateStructuredOps(expectedText,ops);
  if(expected===null) return null;
  let current=readStructuredCell(wasm,address);
  if(current?.text!==expectedText) return null;
  for(const op of ops) {
    const at=point(current.text,op.offset),block=current.blocks[at.block];
    if(!block||at.offset===null) throw new TypeError('Invalid structured cell path');
    const args=[address.section,address.paragraph] as const;
    if(op.type==='insert') {
      const parts=op.text.split('\n');
      for(const [i,part] of parts.entries()) {
        const offset=i===0?at.offset:0,p=path(block,at.paragraph+i);
        if(part) wasm.insertTextInCellByPath(...args,p,offset,decodeCollaborationParagraph(part));
        if(i<parts.length-1) wasm.splitParagraphInCellByPath(...args,p,offset+[...part].length);
      }
    }else if(op.type==='delete') {
      for(const [i,part] of current.text.slice(op.offset,op.offset+op.count).split('\n').entries()) {
        if(i>0) wasm.mergeParagraphInCellByPath(...args,path(block,at.paragraph+1));
        if(part) wasm.deleteTextInCellByPath(...args,path(block,at.paragraph),at.offset,[...part].length);
      }
    }else {
      for(const [i,part] of current.text.slice(op.offset,op.offset+op.count).split('\n').entries()) {
        const offset=i===0?at.offset:0;
        if(part) wasm.applyCharFormatInCellByPath(...args,path(block,at.paragraph+i),offset,offset+[...part].length,JSON.stringify(op.marks));
      }
    }
    current=readStructuredCell(wasm,address);
    if(!current) throw new TypeError('Structured cell changed topology');
  }
  if(current.text!==expected) throw new TypeError('Structured cell text mismatch');
  return current.text;
}
export function structuredManifest(wasm:StructuredCellWasm,region:CollaborationRegionV1,groupRuns:(text:string,props:(offset:number)=>CharProperties,starts?:readonly number[])=>readonly CollaborationRunV1[]):CollaborationManifestRegionV1 {
  const address=structuredAddress(region.importAddress??region.id),value=address&&readStructuredCell(wasm,address);
  if(!address||!value) throw new TypeError('Unsupported structured cell');
  let offset=0,index=0;
  const paragraphs=value.blocks.flatMap((block,bi)=>block.paragraphs.map((entry,pi)=>{
    const text=encode(entry.text)!;
    const runs=groupRuns(text,(at)=>wasm.getCellCharPropertiesAtByPath(address.section,address.paragraph,path(block,pi),at),entry.charRunStarts).flatMap(run=>{
      const result:CollaborationRunV1[]=[];let start=run.start;
      for(let i=run.start;i<run.end;i++) if(text[i]===STRUCTURED_OBJECT){if(i>start) result.push({...run,start,end:i});start=i+1;}
      if(start<run.end) result.push({...run,start}); return result;
    });
    const result={id:`${region.id}:p:${index++}`,text,paragraph:entry.paragraph,runs,offset};
    offset+=text.length+1;
    return result;
  }));
  const first=paragraphs[0]!;
  return {id:region.id,kind:'cell',text:value.text,paragraph:first.paragraph,
    runs:paragraphs.flatMap(p=>p.runs.map(r=>({...r,start:r.start+p.offset,end:r.end+p.offset}))),
    paragraphs:paragraphs.map(({offset,...p})=>p),table:{structured:true,signature:JSON.stringify(value.topology)}};
}
export function structuredPosition(wasm:StructuredCellReader,pos:DocumentPosition):{id:string;offset:number;text:string}|null {
  if(pos.parentParaIndex===undefined||pos.isTextBox) return null;
  const outer=pos.cellPath?.[0];
  const address={section:pos.sectionIndex,paragraph:pos.parentParaIndex,control:outer?.controlIndex??pos.controlIndex!,cell:outer?.cellIndex??pos.cellIndex!};
  if(wasm.isStructuredCollaborationCell?.(address.section,address.paragraph,address.control,address.cell)===false) return null;
  const value=readStructuredCell(wasm,address);if(!value) return null;
  const target=pos.cellPath?.map(p=>({controlIdx:p.controlIndex,cellIdx:p.cellIndex,cellParaIdx:p.cellParaIndex}))
    ??[{controlIdx:address.control,cellIdx:address.cell,cellParaIdx:pos.cellParaIndex??0}];
  let offset=0;
  for(const block of value.blocks) {
    const matches=block.path.length===target.length&&block.path.every((p,i)=>p.controlIdx===target[i]!.controlIdx&&p.cellIdx===target[i]!.cellIdx&&(i===target.length-1||p.cellParaIdx===target[i]!.cellParaIdx));
    const texts=block.paragraphs.map(p=>encode(p.text)!);
    if(matches) {const pi=target.at(-1)!.cellParaIdx,text=texts[pi];if(text===undefined) return null;
      return {id:`c:${address.section}:${address.paragraph}:${address.control}:${address.cell}`,offset:offset+texts.slice(0,pi).reduce((n,p)=>n+p.length+1,0)+[...text].slice(0,pos.charOffset).join('').length,text:value.text};}
    offset+=texts.join('\n').length+1;
  }
  return null;
}

/** Inverse of structuredPosition: focus canonical text in its actual native cell. */
export function structuredNativePosition(wasm:StructuredCellReader,address:StructuredAddress,offset:number):DocumentPosition|null {
  const value=readStructuredCell(wasm,address);
  if(!value||!Number.isSafeInteger(offset)||offset<0||offset>value.text.length) return null;
  const at=point(value.text,offset),block=value.blocks[at.block];
  if(!block||at.offset===null||!block.paragraphs[at.paragraph]) return null;
  const cellPath=block.path.map((entry,index)=>({
    controlIndex:entry.controlIdx,cellIndex:entry.cellIdx,
    cellParaIndex:index===block.path.length-1?at.paragraph:entry.cellParaIdx,
  }));
  const outer=cellPath[0]!;
  return {sectionIndex:address.section,paragraphIndex:address.paragraph,parentParaIndex:address.paragraph,
    controlIndex:outer.controlIndex,cellIndex:outer.cellIndex,cellParaIndex:outer.cellParaIndex,
    charOffset:at.offset,cellPath};
}

/** Keep a viewer/second tab's nested caret anchored through accepted text edits. */
export function structuredPositionRemapper(address:StructuredAddress,before:StructuredCell,after:StructuredCell,ops:readonly CollaborationOpV1[]):(position:DocumentPosition)=>DocumentPosition {
  const oldReader:StructuredCellReader={getCollaborationStructuredCell:()=>before};
  const newReader:StructuredCellReader={getCollaborationStructuredCell:()=>after};
  const regionId=`c:${address.section}:${address.paragraph}:${address.control}:${address.cell}`;
  return position=>{
    const old=structuredPosition(oldReader,position);
    if(!old||old.id!==regionId) return position;
    let offset=old.offset;
    for(const op of ops) {
      if(op.type==='insert'&&op.offset<=offset) offset+=op.text.length;
      if(op.type==='delete'&&op.offset<offset) offset-=Math.min(op.count,offset-op.offset);
    }
    return structuredNativePosition(newReader,address,offset)??position;
  };
}
