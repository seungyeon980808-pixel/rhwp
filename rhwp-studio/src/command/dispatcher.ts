import type { EventBus } from '@/core/event-bus';
import type { CommandRegistry } from './registry';
import type { CommandServices, EditorContext } from './types';
import { isUnsupportedLiveFormat, unsupportedLiveFormatReason } from '../embed/collaboration-format-boundary.ts';
import { isUnsupportedLiveStructure, unsupportedLiveStructureReason } from '../embed/collaboration-structure-boundary.ts';

const FORM_MODE_BLOCKED_IDS = new Set([
  'edit:cut',
  'edit:paste',
  'edit:delete',
  'field:edit',
  'field:remove',
  // [#2361 리뷰] 편집 용지의 파일 메뉴/F7 변형. page:setup 은 'page:' prefix 로 차단되는데
  // 이 변형만 열려 있었다 — 양식 모드에선 snapshot 이 드롭되므로(입력-핸들러 게이트) 다이얼로그가
  // 열리면 확인이 무언 폐기된다. 두 진입점을 동일하게 차단해 정합.
  'file:page-setup',
]);

const FORM_MODE_BLOCKED_PREFIXES = [
  'format:',
  'insert:',
  'table:',
  'page:',
];

function isBlockedInFormMode(commandId: string, ctx: EditorContext): boolean {
  if (!ctx.isFormMode) return false;
  if (FORM_MODE_BLOCKED_IDS.has(commandId)) return true;
  return FORM_MODE_BLOCKED_PREFIXES.some(prefix => commandId.startsWith(prefix));
}

/** 통합 커맨드 디스패처: 메뉴/툴바/키보드 모든 입력의 단일 실행 경로 */
const documentTableCommand = (command: string) => command.startsWith('table:') && command !== 'table:transpose-copy';
export class CommandDispatcher {
  private pendingDocumentCommand: { id: string; params?: Record<string, unknown> } | null = null;
  private pendingDocumentOperation: (() => void) | null = null;
  deferDocumentOperation(operation: () => void): boolean {
    const ctx = this.services.getContext();
    if (ctx.documentEditTableAddress) { this.eventBus.emit('command-blocked', '표의 변경을 먼저 저장한 뒤 크기를 조절하세요.'); return true; }
    if (!ctx.isLiveCollaboration) return false;
    if (!ctx.canRequestDocumentEdit) { this.eventBus.emit('command-blocked', unsupportedLiveStructureReason); return true; }
    if (this.pendingDocumentOperation) return true;
    this.pendingDocumentOperation = operation;
    this.services.requestDocumentEdit?.('table:pending-resize');
    return true;
  }
  cancelPendingDocumentOperation(): void { this.pendingDocumentOperation = null; this.pendingDocumentCommand = null; }
  resumePendingDocumentCommand(command: string): boolean {
    if (this.services.getContext().isLiveCollaboration || this.services.getContext().isDocumentEditFrozen) return false;
    const pending = this.pendingDocumentCommand;
    if (!pending || pending.id !== command) return false;
    this.pendingDocumentCommand = null;
    return this.dispatch(pending.id, pending.params);
  }
  resumePendingDocumentOperation(): boolean {
    if (this.services.getContext().isLiveCollaboration || this.services.getContext().isDocumentEditFrozen) return false;
    const operation = this.pendingDocumentOperation; this.pendingDocumentOperation = null;
    if (!operation) return false;
    operation(); return true;
  }

  constructor(
    private registry: CommandRegistry,
    private services: CommandServices,
    private eventBus: EventBus,
  ) {}

  /**
   * 커맨드 실행.
   * @returns true: 실행됨, false: 미등록 또는 비활성
   */
  dispatch(commandId: string, params?: Record<string, unknown>): boolean {
    const def = this.registry.get(commandId);
    if (!def) {
      console.warn(`[CommandDispatcher] 미등록 커맨드: ${commandId}`);
      return false;
    }

    const reason = this.disabledReason(commandId);
    if (reason) {
      this.eventBus.emit('command-blocked', reason);
      return false;
    }

    const ctx = this.services.getContext();
    if (ctx.isLiveCollaboration && ctx.canRequestDocumentEdit && documentTableCommand(commandId)) {
      this.pendingDocumentCommand = { id: commandId, params };
      this.services.requestDocumentEdit?.(commandId, params);
      return false;
    }
    try {
      def.execute(this.services, params);
      // 커맨드 실행 후 UI 상태 갱신 알림
      this.eventBus.emit('command-state-changed');
      return true;
    } catch (err) {
      console.error(`[CommandDispatcher] 커맨드 실행 실패: ${commandId}`, err);
      return false;
    }
  }

  /**
   * 커맨드가 현재 활성(실행 가능)인지 확인.
   * 메뉴/툴바의 enabled/disabled 상태 갱신에 사용.
   */
  isEnabled(commandId: string): boolean {
    return this.registry.get(commandId) !== undefined && this.disabledReason(commandId) === undefined;
  }

  disabledReason(commandId: string): string | undefined {
    const def = this.registry.get(commandId);
    if (!def) return '지원하지 않는 명령입니다.';
    const ctx = this.services.getContext();
    if (ctx.documentEditTableAddress && !commandId.startsWith('view:') && !commandId.startsWith('file:') && commandId !== 'edit:copy') {
      if (commandId.startsWith('table:') && !['table:cell-props', 'table:border-each', 'table:border-one', 'table:insert-row-col', 'table:delete-row-col', 'table:insert-row-above', 'table:insert-row-below', 'table:insert-col-left', 'table:insert-col-right', 'table:delete-row', 'table:delete-col', 'table:cell-split', 'table:cell-merge', 'table:cell-height-equal', 'table:cell-width-equal'].includes(commandId))
        return '이 표의 변경을 먼저 저장한 뒤 다른 표 작업을 시작하세요.';
      if (this.services.getInputHandler?.()?.canEditDocumentTableSelection?.() === false)
        return '현재 편집 중인 표만 수정할 수 있습니다. 변경을 저장한 뒤 다른 영역을 선택하세요.';
    }
    if (ctx.isDocumentEditFrozen) return '문서 저장 또는 연결 확인이 끝나면 편집할 수 있습니다.';
    if (this.services.wasm?.hasRestrictedPromptSpaces?.() && commandId.startsWith('format:align-'))
      return '담당 구간을 나눈 문단의 정렬은 변경할 수 없습니다.';
    if (isBlockedInFormMode(commandId, ctx)) return '양식 입력 모드에서는 이 명령을 사용할 수 없습니다.';
    if (isUnsupportedLiveFormat(commandId, ctx.isLiveCollaboration === true && !(ctx.canRequestDocumentEdit && documentTableCommand(commandId)))) return unsupportedLiveFormatReason;
    if (isUnsupportedLiveStructure(commandId, ctx.isLiveCollaboration === true && !ctx.canRequestDocumentEdit)) return unsupportedLiveStructureReason;
    if (def.canExecute && !def.canExecute(ctx)) return '이 명령을 사용할 수 있는 문서 영역을 먼저 선택하세요.';
    if (ctx.isLiveCollaboration && !(ctx.canRequestDocumentEdit && documentTableCommand(commandId)) && (commandId.startsWith('format:') || commandId.startsWith('insert:')
      || commandId.startsWith('table:') && commandId !== 'table:transpose-copy')
      && this.services.getInputHandler?.()?.canEditLiveSelection?.() === false)
      return '선택한 영역을 편집할 수 없습니다. 담당 범위와 다른 참여자의 작성 상태를 확인하세요.';
    return undefined;
  }
}
