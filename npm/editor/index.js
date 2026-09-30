/**
 * @rhwp/editor — HWP 에디터를 iframe으로 임베드
 *
 * 사용법:
 *   import { createEditor } from '@rhwp/editor';
 *   const editor = await createEditor('#container');
 *   await editor.loadFile(buffer, 'document.hwp');
 *
 * 본 제품은 한글과컴퓨터의 한글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.
 */

import { EditorTransport } from './transport.js';
import {
  validateApprovedTemplateEditResult,
  validateApprovedTemplateInspection,
} from './approved-template-contracts.js';

const DEFAULT_STUDIO_URL = 'https://edwardkim.github.io/rhwp/';

/**
 * HWP 에디터를 생성하여 지정된 컨테이너에 마운트합니다.
 *
 * @param container - CSS 셀렉터 또는 HTMLElement
 * @param options - 에디터 옵션
 * @returns RhwpEditor 인스턴스
 *
 * @example
 * ```javascript
 * const editor = await createEditor('#editor');
 * await editor.loadFile(hwpBuffer, 'sample.hwp');
 * console.log(await editor.pageCount());
 * ```
 */
export async function createEditor(container, options = {}) {
  const el = typeof container === 'string'
    ? document.querySelector(container)
    : container;

  if (!el) {
    throw new Error(`Container not found: ${container}`);
  }

  let studioUrl = options.studioUrl || DEFAULT_STUDIO_URL;
  if (options.renderer !== undefined) {
    if (!['auto', 'canvas2d', 'canvaskit'].includes(options.renderer)) {
      throw new TypeError(`Unsupported renderer: ${options.renderer}`);
    }
    const resolvedStudioUrl = new URL(studioUrl, document.baseURI);
    resolvedStudioUrl.searchParams.set('renderer', options.renderer);
    studioUrl = resolvedStudioUrl.href;
  }

  // iframe 생성
  const iframe = document.createElement('iframe');
  iframe.src = studioUrl;
  iframe.style.width = options.width || '100%';
  iframe.style.height = options.height || '100%';
  iframe.style.border = 'none';
  iframe.allow = 'clipboard-read; clipboard-write';

  // 캐시된 로컬 Studio는 appendChild 직후 동기적으로 load가 끝날 수 있으므로
  // 리스너를 먼저 등록해 패키지 앱의 초기화 경쟁을 막는다.
  const iframeLoaded = new Promise((resolve) => {
    iframe.addEventListener('load', resolve, { once: true });
  });
  el.appendChild(iframe);
  await iframeLoaded;

  // WASM 초기화 대기 (ready 메서드로 확인)
  let transport;
  try {
    transport = new EditorTransport(iframe, studioUrl, {
      requestTimeoutMs: options.requestTimeoutMs,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
    });
    await transport.connect();
    const editor = new RhwpEditor(iframe, transport);
    await editor._waitReady();
    return editor;
  } catch (error) {
    transport?.destroy();
    iframe.remove();
    throw error;
  }
}

/**
 * HWP 에디터 인스턴스
 *
 * iframe 내부의 rhwp-studio와 postMessage로 통신합니다.
 */
export class RhwpEditor {
  constructor(iframe, transport) {
    this._iframe = iframe;
    this._transport = transport;
    this._collaborationMutationListeners = new Set();
    this._bodyStructureListeners = new Set();
    this._bodyStructureDelivered = null;
    this._collaborationMutationSequence = 0;
    this._collaborationMutationTimer = null;
  }

  /**
   * iframe에 요청을 보내고 응답을 기다립니다.
   * @internal
   */
  _request(method, params = {}) {
    return this._transport.request(method, params);
  }

  /** WASM 초기화 완료 대기 @internal */
  async _waitReady() {
    for (let i = 0; i < 30; i++) {
      try {
        const result = await this._request('ready');
        if (result) return;
      } catch {
        // 아직 준비 안 됨 — 재시도
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Editor initialization timeout');
  }

  /**
   * HWP 파일을 로드합니다.
   *
   * @param data - HWP 파일의 ArrayBuffer 또는 Uint8Array
   * @param fileName - 파일 이름 (선택)
   * @param options - 로드 옵션 (선택)
   * @param options.skipUnsavedGuard - 미저장 변경 확인 없이 문서 교체
   * @param options.suppressDialogs - 로드 후 안내창(HWPX 검증, 로컬 글꼴 감지) 없이 열기.
   *   임베드 환경에서 안내창의 사용자 선택을 기다리느라 loadFile 응답이 지연/교착되는
   *   것을 방지한다. 검증 경고는 '그대로 열기'로 처리되고, 글꼴은 웹 대체 글꼴로 표시된다.
   * @returns { pageCount: number }
   *
   * @example
   * ```javascript
   * const resp = await fetch('document.hwp');
   * const buffer = await resp.arrayBuffer();
   * const result = await editor.loadFile(buffer, 'document.hwp');
   * console.log(`${result.pageCount}페이지`);
   * ```
   */
  async loadFile(data, fileName = 'document.hwp', options = {}) {
    return this._request('loadFile', {
      data,
      fileName,
      skipUnsavedGuard: options.skipUnsavedGuard === true,
      suppressDialogs: options.suppressDialogs === undefined || options.suppressDialogs === true,
    });
  }

  /**
   * 현재 문서의 페이지 수를 반환합니다.
   * @returns 페이지 수
   */
  async pageCount() {
    return this._request('pageCount');
  }

  /**
   * 특정 페이지를 SVG 문자열로 렌더링합니다.
   * @param page - 0부터 시작하는 페이지 번호
   * @returns SVG 문자열
   */
  async getPageSvg(page = 0) {
    return this._request('getPageSvg', { page });
  }

  /**
   * 선택된 renderer와 페이지별 CanvasKit readiness 진단을 반환합니다.
   * @param page - 0부터 시작하는 페이지 번호
   */
  async getRendererDiagnostics(page = 0) {
    if (!Number.isSafeInteger(page) || page < 0) {
      throw new TypeError('page must be a non-negative safe integer');
    }
    if (!this._transport.supports('renderer-diagnostics-v1')) {
      throw new Error('Renderer diagnostics v1 is not supported by this Studio');
    }
    const result = await this._request('getRendererDiagnostics', { page });
    if (result?.schemaVersion !== 1 || result?.page?.index !== page) {
      throw new Error('Studio returned invalid renderer diagnostics v1');
    }
    return result;
  }

  /**
   * 현재 문서를 HWP 바이너리로 내보냅니다.
   * @returns {Promise<Uint8Array>} HWP 파일 bytes
   */
  async exportHwp() {
    const result = await this._request('exportHwp');
    return result instanceof Uint8Array ? result : new Uint8Array(result || []);
  }

  /** 직렬화 후 같은 바이트를 재로드 검증하여 저장 가능한 HWP bytes를 반환합니다. */
  async exportHwpVerified() {
    const result = await this._request('exportHwpVerified');
    return result instanceof Uint8Array ? result : new Uint8Array(result || []);
  }

  /**
   * 현재 문서를 HWPX(ZIP+XML) 바이너리로 내보냅니다.
   * @returns {Promise<Uint8Array>} HWPX 파일 bytes
   */
  async exportHwpx() {
    const result = await this._request('exportHwpx');
    return result instanceof Uint8Array ? result : new Uint8Array(result || []);
  }

  /** 현재 문서를 HML(XML) 바이너리로 내보냅니다. */
  async exportHml() {
    const result = await this._request('exportHml');
    return result instanceof Uint8Array ? result : new Uint8Array(result || []);
  }

  /** 현재 문서의 HML 저장 가능 여부와 blocker를 반환합니다. */
  async getHmlSaveState() {
    return this._request('getHmlSaveState');
  }

  /**
   * HWP 직렬화 + 자기 재로드 검증 메타데이터를 반환합니다 (#178).
   *
   * 검증 메타데이터만 반환하며, 실제 HWP bytes 가 필요하면 `exportHwp()` 를 별도 호출하세요.
   *
   * @returns {Promise<{bytesLen: number, pageCountBefore: number, pageCountAfter: number, recovered: boolean}>}
   */
  async exportHwpVerify() {
    return this._request('exportHwpVerify');
  }

  /**
   * 내보내기 바이트의 영속화(업로드/핸드오프) 완료를 스튜디오에 통지합니다.
   *
   * dirty 상태를 해제하고 자동복구 draft의 IndexedDB 삭제 "완료"까지 기다린 뒤
   * resolve합니다 — resolve 이후 창을 닫아도 안전합니다. 업로드 실패 시에는
   * 호출하지 마세요(백업 draft가 보존되어야 합니다).
   *
   * 스튜디오가 `notify-saved-v1` capability를 광고하지 않으면(구버전 또는
   * legacy 폴백 연결) 요청을 보내지 않고 명시적으로 실패합니다.
   *
   * @param fileName - 호스트가 저장에 사용한 파일 이름 (선택)
   * @returns {Promise<{ ok: true, wasDirty: boolean }>}
   */
  async notifySaved(fileName) {
    if (!this._transport.supports('notify-saved-v1')) {
      throw new Error('notifySaved is not supported by this Studio');
    }
    const params = typeof fileName === 'string' && fileName.length > 0 ? { fileName } : {};
    return this._request('notifySaved', params);
  }

  /** 검증된 HWP 바이트와 같은 JS turn의 문서 revision을 저장용으로 반환합니다. */
  async exportDocumentForSave(format) {
    if (!['hwp', 'hwpx', 'hml'].includes(format)) {
      throw new TypeError('format must be hwp, hwpx, or hml');
    }
    if (!this._transport.supports('revisioned-save-v1')) {
      throw new Error('Revisioned save v1 is not supported by this Studio');
    }
    const result = await this._request('exportDocumentForSave', { format });
    const keys = result && typeof result === 'object' ? Object.keys(result) : [];
    if (result?.schemaVersion !== 1 || !(result.bytes instanceof Uint8Array)
        || !Number.isSafeInteger(result.revision) || result.revision < 0
        || keys.length !== 3) {
      throw new Error('Invalid revisioned save export from Studio');
    }
    return result;
  }

  /** 내보낸 뒤 문서가 바뀌지 않은 경우에만 dirty와 복구 draft를 해제합니다. */
  async notifySavedIfUnchanged(revision, fileName) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TypeError('revision must be a non-negative safe integer');
    }
    if (!this._transport.supports('revisioned-save-v1')) {
      throw new Error('Revisioned save v1 is not supported by this Studio');
    }
    const result = await this._request('notifySavedIfUnchanged', {
      revision,
      ...(typeof fileName === 'string' && fileName.length > 0 ? { fileName } : {}),
    });
    const keys = result && typeof result === 'object' ? Object.keys(result) : [];
    const valid = result?.ok === true
      ? typeof result.wasDirty === 'boolean' && keys.length === 3
      : result?.ok === false && result.reason === 'document-changed' && keys.length === 3;
    if (!valid || !Number.isSafeInteger(result.currentRevision) || result.currentRevision < 0) {
      throw new Error('Invalid revisioned save acknowledgement from Studio');
    }
    return result;
  }

  /**
   * 현재 텍스트 선택을 변경 충돌 검사용 snapshot으로 반환합니다.
   * 선택이 없거나 지원 범위 밖이면 null을 반환합니다.
   */
  async getSelectionSnapshot() {
    if (!this._transport.supports('selection-edit-v1')) {
      throw new Error('Selection edit v1 is not supported by this Studio');
    }
    return this._request('getSelectionSnapshot');
  }

  /**
   * 선택 snapshot이 여전히 유효할 때만 텍스트를 교체합니다.
   *
   * @param snapshotId - getSelectionSnapshot()이 반환한 snapshot id
   * @param text - 교체할 텍스트
   */
  async replaceSelection(snapshotId, text) {
    if (!this._transport.supports('selection-edit-v1')) {
      throw new Error('Selection edit v1 is not supported by this Studio');
    }
    if (typeof snapshotId !== 'string' || snapshotId.length === 0) {
      throw new TypeError('snapshotId must be a non-empty string');
    }
    if (typeof text !== 'string') {
      throw new TypeError('text must be a string');
    }
    return this._request('replaceSelection', { snapshotId, text });
  }

  /** 현재 문서의 입력 가능한 누름틀 목록을 반환합니다. */
  async getFields() {
    if (!this._transport.supports('field-fill-v1')) {
      throw new Error('Field fill v1 is not supported by this Studio');
    }
    return this._request('getFields');
  }

  /** 필드 값 여러 개를 하나의 실행 취소 단위로 적용합니다. */
  async fillFields(entries) {
    if (!this._transport.supports('field-fill-v1')) {
      throw new Error('Field fill v1 is not supported by this Studio');
    }
    if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
    return this._request('fillFields', { entries });
  }

  /** 승인 템플릿의 구조 digest와 안전한 가상 필드 후보를 읽기 전용으로 조사합니다. */
  async inspectApprovedTemplate() {
    if (!this._transport.supports('approved-template-edit-v1')) {
      throw new Error('Approved template edit v1 is not supported by this Studio');
    }
    return validateApprovedTemplateInspection(await this._request('inspectApprovedTemplate'));
  }

  /** 승인 템플릿 편집 요청 전체를 문서 변경 없이 사전 검증합니다. */
  async preflightApprovedTemplateEdits(request) {
    if (!this._transport.supports('approved-template-edit-v1')) {
      throw new Error('Approved template edit v1 is not supported by this Studio');
    }
    if (!request || typeof request !== 'object') {
      throw new TypeError('request must be an object');
    }
    return validateApprovedTemplateEditResult(
      await this._request('preflightApprovedTemplateEdits', { request }),
    );
  }

  /** 검증 token이 현재 문서와 일치할 때만 요청 전체를 한 undo 단위로 적용합니다. */
  async applyApprovedTemplateEdits(request, preflightToken) {
    if (!this._transport.supports('approved-template-edit-v1')) {
      throw new Error('Approved template edit v1 is not supported by this Studio');
    }
    if (!request || typeof request !== 'object') {
      throw new TypeError('request must be an object');
    }
    if (typeof preflightToken !== 'string' || preflightToken.length === 0) {
      throw new TypeError('preflightToken must be a non-empty string');
    }
    return validateApprovedTemplateEditResult(
      await this._request('applyApprovedTemplateEdits', { request, preflightToken }),
    );
  }

  /** Studio 히스토리의 최상위 편집 한 건을 기존 Undo 경로로 되돌립니다. */
  async undo() {
    if (!this._transport.supports('history-undo-v1')) {
      throw new Error('History undo v1 is not supported by this Studio');
    }
    const result = await this._request('undo');
    const keys = result && typeof result === 'object' ? Object.keys(result) : [];
    if (result?.ok === true && keys.length === 1 && keys[0] === 'ok') {
      return result;
    }
    if (result?.ok === false
        && keys.length === 2
        && keys.includes('ok')
        && keys.includes('reason')
        && ['empty-history', 'editor-not-ready', 'undo-failed'].includes(result.reason)) {
      return result;
    }
    throw new Error('Invalid history undo result from Studio');
  }

  /** 현재 iframe을 영구 협업 읽기 전용 모드로 전환합니다. */
  async beginCollaboration() {
    this._requireCollaborationCapability();
    const result = await this._request('beginCollaboration');
    if (result?.schemaVersion !== 1 || result?.readOnly !== true
        || Object.keys(result).length !== 2) {
      throw new Error('Invalid collaboration begin result from Studio');
    }
    return result;
  }

  async beginLiveCollaboration() {
    this._requireLiveCollaborationCapability();
    const result = await this._request('beginLiveCollaboration');
    if (result?.schemaVersion !== 1 || result?.readOnly !== false
        || Object.keys(result).length !== 2) {
      throw new Error('Invalid live collaboration begin result from Studio');
    }
    return result;
  }

  async setLivePastePolicy(policy) {
    this._requireLiveCollaborationCapability();
    await this._request('setLivePastePolicy', policy);
  }

  async configureBodyStructure(configuration) {
    this._requireLiveCollaborationCapability();
    await this._request('configureBodyStructure', configuration);
  }

  async getBodyStructureRequests() {
    this._requireLiveCollaborationCapability();
    const result = await this._request('getBodyStructureRequests');
    if (!Array.isArray(result) || result.length > 1 || !result.every(isBodyStructureRequest))
      throw new TypeError('Invalid body structure request from Studio');
    return result;
  }

  async resolveBodyStructure(resolution) {
    this._requireLiveCollaborationCapability();
    const result = await this._request('resolveBodyStructure', resolution);
    if (result === null && resolution.receipt === null) return null;
    if (!result || typeof result.applied !== 'boolean' || !Array.isArray(result.tombstones) || !result.tombstones.every(id => typeof id === 'string')
      || !Array.isArray(result.regions) || !result.regions.every(isCollaborationRegion)
      || !Array.isArray(result.removedRegionIds) || !result.removedRegionIds.every((id) => typeof id === 'string')
      || !result.cursor || !['sectionIndex', 'paragraphIndex', 'charOffset'].every((key) =>
        Number.isSafeInteger(result.cursor[key]) && result.cursor[key] >= 0))
      throw new TypeError('Invalid body structure result from Studio');
    return result;
  }

  async applyRemoteBodyStructure(request) {
    this._requireLiveCollaborationCapability();
    const outcome = await this._request('applyRemoteBodyStructure', request);
    if (outcome?.status === 'deferred' && ['pending', 'composing', 'dirty', 'stale'].includes(outcome.reason)
      && outcome.recovery === 'reconcile') return outcome;
    const result = outcome?.result;
    if (!['applied', 'duplicate'].includes(outcome?.status) || !result
      || result.applied !== (outcome.status === 'applied')
      || !Array.isArray(result.tombstones) || !result.tombstones.every(id => typeof id === 'string')
      || !Array.isArray(result.regions) || !result.regions.every(isCollaborationRegion)
      || !Array.isArray(result.removedRegionIds) || !result.removedRegionIds.every(id => typeof id === 'string')
      || !result.cursor || !['sectionIndex', 'paragraphIndex', 'charOffset'].every(key =>
        Number.isSafeInteger(result.cursor[key]) && result.cursor[key] >= 0))
      throw new TypeError('Invalid remote body structure result from Studio');
    return outcome;
  }

  onBodyStructureRequest(listener) {
    this._requireLiveCollaborationCapability();
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this._bodyStructureListeners.add(listener);
    this._scheduleCollaborationMutationPoll();
    return () => this._bodyStructureListeners.delete(listener);
  }

  /** 현재 원본 구조에서 지원되는 협업 텍스트 영역을 반환합니다. */
  async getCollaborationPresence() {
    this._requireCollaborationCapability();
    const result = await this._request('getCollaborationPresence');
    if (result === null) return null;
    if (!result || typeof result !== 'object' || Array.isArray(result)
        || Object.keys(result).some((key) => !['regionId', 'anchorOffset', 'focusOffset', 'anchorRegionId',
          'anchorCellParagraphIndex', 'focusCellParagraphIndex'].includes(key))
        || typeof result.regionId !== 'string' || !/^(?:b:\d+:\d+|c:\d+:\d+:\d+:\d+)$/.test(result.regionId)
        || !isCollaborationSelection(result))
      throw new TypeError('Invalid collaboration presence from Studio');
    return result;
  }

  async getCollaborationRegionRects(request) {
    this._requireCollaborationCapability();
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).some((key) => key !== 'regionId' && key !== 'selection') || typeof request.regionId !== 'string'
        || !/^(?:b:\d+:\d+|c:\d+:\d+:\d+:\d+)$/.test(request.regionId)
        || !request.regionId.split(':').slice(1).every((part) => Number.isSafeInteger(Number(part)))) {
      throw Object.assign(new TypeError('invalid-region-id'), { code: 'invalid-region-id' });
    }
    if (request.selection !== undefined && (!request.selection || typeof request.selection !== 'object'
        || Object.keys(request.selection).some((key) => !['anchorOffset', 'focusOffset', 'anchorRegionId',
          'anchorCellParagraphIndex', 'focusCellParagraphIndex'].includes(key))
        || !isCollaborationSelection(request.selection)))
      throw new TypeError('Invalid collaboration selection');
    const result = await this._request('getCollaborationRegionRects', request);
    if (!isCollaborationRegionRects(result, request.regionId)) {
      throw new TypeError('Invalid collaboration region rectangles from Studio');
    }
    return result;
  }

  async getCollaborationRegions() {
    this._requireCollaborationCapability();
    const result = await this._request('getCollaborationRegions');
    if (!Array.isArray(result) || !result.every(isCollaborationRegion)) {
      throw new Error('Invalid collaboration regions from Studio');
    }
    return result;
  }

  /** expectedText가 현재 영역 텍스트와 일치할 때만 실제 문서를 교체합니다. */
  async applyCollaborationText(request) {
    this._requireCollaborationCapability();
    if (!request || typeof request !== 'object' || Array.isArray(request)
        || Object.keys(request).length !== 3
        || typeof request.regionId !== 'string' || request.regionId.length === 0
        || typeof request.expectedText !== 'string'
        || typeof request.text !== 'string'
        || !isPlainCollaborationText(request.expectedText)
        || !isPlainCollaborationText(request.text)) {
      throw new TypeError(
        'request must contain regionId and single-line plain text expectedText/text',
      );
    }
    const result = await this._request('applyCollaborationText', request);
    if (!isCollaborationApplyResult(result)) {
      throw new Error('Invalid collaboration apply result from Studio');
    }
    return result;
  }

  async applyCollaborationOps(request) {
    this._requireLiveCollaborationCapability();
    if (!isCollaborationOpsRequest(request)) {
      throw new TypeError('request must contain regionId, expectedText, origin, and valid ops');
    }
    const result = await this._request('applyCollaborationOps', request);
    if (!isCollaborationOpsResult(result)) {
      throw new Error('Invalid collaboration ops result from Studio');
    }
    return result;
  }

  async getCollaborationManifest() {
    this._requireLiveCollaborationCapability();
    const result = await this._request('getCollaborationManifest');
    if (!result || result.schemaVersion !== 1 || !Array.isArray(result.regions)
        || !Array.isArray(result.resources) || !Array.isArray(result.missing)) {
      throw new Error('Invalid collaboration manifest from Studio');
    }
    return result;
  }

  onCollaborationMutation(listener) {
    this._requireLiveCollaborationCapability();
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    this._collaborationMutationListeners.add(listener);
    this._scheduleCollaborationMutationPoll();
    return () => {
      this._collaborationMutationListeners.delete(listener);
      if (this._collaborationMutationListeners.size === 0
          && this._bodyStructureListeners.size === 0
          && this._collaborationMutationTimer !== null) {
        clearTimeout(this._collaborationMutationTimer);
        this._collaborationMutationTimer = null;
      }
    };
  }

  async flushCollaborationMutations() {
    this._requireLiveCollaborationCapability();
    if (this._collaborationMutationPoll) return this._collaborationMutationPoll;
    this._collaborationMutationPoll = (async () => {
      const mutations = await this._request('getCollaborationMutations', { afterSequence: this._collaborationMutationSequence });
      if (!Array.isArray(mutations) || !mutations.every(isCollaborationMutation))
        throw new Error('Invalid collaboration mutations from Studio');
      for (const mutation of mutations) {
        this._collaborationMutationSequence = Math.max(this._collaborationMutationSequence, mutation.sequence);
        for (const listener of this._collaborationMutationListeners) listener(mutation);
      }
      if (this._bodyStructureListeners.size) {
        for (const request of await this.getBodyStructureRequests()) {
          if (this._bodyStructureDelivered === request.planId) continue;
          this._bodyStructureDelivered = request.planId;
          for (const listener of this._bodyStructureListeners) listener(request);
        }
      }
    })();
    try { await this._collaborationMutationPoll; }
    finally { this._collaborationMutationPoll = null; }
  }

  _scheduleCollaborationMutationPoll() {
    if (this._collaborationMutationTimer !== null
        || (this._collaborationMutationListeners.size === 0 && this._bodyStructureListeners.size === 0)) return;
    this._collaborationMutationTimer = setTimeout(async () => {
      this._collaborationMutationTimer = null;
      try {
        await this.flushCollaborationMutations();
      } catch (error) {
        if (this._collaborationMutationListeners.size > 0 || this._bodyStructureListeners.size > 0) {
          queueMicrotask(() => { throw error; });
        }
      }
      this._scheduleCollaborationMutationPoll();
    }, 25);
  }

  _requireCollaborationCapability() {
    if (!this._transport.supports('collaboration-text-v1')) {
      throw new Error('Collaboration text v1 is not supported by this Studio');
    }
  }

  _requireLiveCollaborationCapability() {
    if (!this._transport.supports('collaboration-live-v1')) {
      throw new Error('Collaboration live v1 is not supported by this Studio');
    }
  }

  /**
   * HWP/HWPX/HML 바이트에서 참고 텍스트를 추출합니다.
   * Studio는 현재 편집 문서와 분리된 임시 WASM 문서를 사용하므로 dirty/undo/render 상태를
   * 바꾸지 않습니다.
   */
  async extractReferenceText(data, fileName, options = {}) {
    if (!this._transport.supports('reference-text-extract-v1')) {
      throw new Error('Reference text extract v1 is not supported by this Studio');
    }
    if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) {
      throw new TypeError('data must be an ArrayBuffer or typed array');
    }
    const byteLength = data.byteLength;
    if (byteLength === 0 || byteLength > 50 * 1024 * 1024) {
      throw new RangeError('reference data must be between 1 byte and 50 MiB');
    }
    if (typeof fileName !== 'string' || fileName.length > 255
        || /[\\/]/u.test(fileName) || !/\.(?:hwp|hwpx|hml)$/iu.test(fileName)) {
      throw new TypeError('fileName must be a basename ending in HWP, HWPX, or HML');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).some((key) => key !== 'maxChars' && key !== 'maxPages')) {
      throw new TypeError('options must contain only maxChars and maxPages');
    }
    const maxChars = options.maxChars ?? 100_000;
    const maxPages = options.maxPages ?? 50;
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 1_000_000) {
      throw new RangeError('maxChars must be an integer between 1 and 1000000');
    }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) {
      throw new RangeError('maxPages must be an integer between 1 and 100');
    }
    return this._request('extractReferenceText', {
      data,
      fileName,
      options: { maxChars, maxPages },
    });
  }

  /**
   * iframe 엘리먼트를 반환합니다.
   */
  get element() {
    return this._iframe;
  }

  /**
   * 에디터를 제거합니다.
   */
  destroy() {
    if (this._collaborationMutationTimer !== null) {
      clearTimeout(this._collaborationMutationTimer);
      this._collaborationMutationTimer = null;
    }
    this._collaborationMutationListeners.clear();
    this._bodyStructureListeners.clear();
    this._transport.destroy();
    this._iframe.remove();
  }
}

function isCollaborationSelection(value) {
  return [value.anchorOffset, value.focusOffset].every((offset) => Number.isSafeInteger(offset) && offset >= 0)
    && [value.anchorCellParagraphIndex, value.focusCellParagraphIndex]
      .every((index) => index === undefined || (Number.isSafeInteger(index) && index >= 0))
    && (value.anchorRegionId === undefined || (typeof value.anchorRegionId === 'string'
      && /^(?:b:\d+:\d+|c:\d+:\d+:\d+:\d+)$/.test(value.anchorRegionId)
      && value.anchorRegionId.split(':').slice(1).every((part) => Number.isSafeInteger(Number(part)))));
}

function isCollaborationRegionRects(value, regionId) {
  return value !== null && typeof value === 'object' && value.schemaVersion === 1
    && value.regionId === regionId && Array.isArray(value.pages)
    && (value.missing === undefined || (Array.isArray(value.missing)
      && value.missing.length > 0 && value.missing.every((reason) => typeof reason === 'string' && reason.length > 0)))
    && (value.pages.length > 0 || value.missing?.length > 0)
    && new Set(value.pages.map((page) => page?.pageIndex)).size === value.pages.length
    && value.pages.every((page) => page !== null && typeof page === 'object'
      && Number.isSafeInteger(page.pageIndex) && page.pageIndex >= 0
      && Array.isArray(page.rects) && page.rects.length > 0
      && page.rects.every((rect) => rect !== null && typeof rect === 'object'
        && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
        && rect.width >= 0 && rect.height > 0));
}

function isPlainCollaborationText(value) {
  return value.length <= 20_000 && !/[\u0000-\u001f\u007f\ufffc]/u.test(value);
}

function isCollaborationRegion(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).every((key) => ['id', 'kind', 'label', 'text', 'importAddress'].includes(key))
    && typeof value.id === 'string'
    && (/^(?:b:\d+:\d+|c:\d+:\d+:\d+:\d+)$/u.test(value.id)
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.id))
    && (value.importAddress === undefined || (typeof value.importAddress === 'string'
      && /^(?:b:\d+:\d+|c:\d+:\d+:\d+:\d+)$/u.test(value.importAddress)))
    && (value.kind === 'body' || value.kind === 'cell')
    && typeof value.label === 'string'
    && typeof value.text === 'string'
    && value.text.length <= 20_000
    && (value.kind === 'cell'
      ? value.text.split('\n').every(isPlainCollaborationText)
      : isPlainCollaborationText(value.text));
}

function isCollaborationApplyResult(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1 || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok) {
    return Object.keys(value).length === 4
      && isCollaborationRegion(value.region)
      && Number.isSafeInteger(value.revision)
      && value.revision >= 0;
  }
  return Object.keys(value).length === 3
    && [
      'region-not-found',
      'expected-text-mismatch',
      'unsupported-text',
      'unsupported-region',
    ].includes(value.reason);
}

function isCollaborationOpsRequest(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof value.regionId === 'string' && value.regionId.length > 0
    && typeof value.expectedText === 'string'
    && typeof value.origin === 'string' && value.origin.length > 0
    && Array.isArray(value.ops) && value.ops.length > 0 && value.ops.length <= 1_000
    && value.ops.every((op) => op !== null && typeof op === 'object' && !Array.isArray(op)
      && Number.isSafeInteger(op.offset)
      && (op.type === 'insert' ? typeof op.text === 'string' : op.type === 'format'
        ? op.version === 1 && Number.isSafeInteger(op.count) && ['character', 'paragraph'].includes(op.scope)
          && op.marks !== null && typeof op.marks === 'object' && !Array.isArray(op.marks)
        : op.type === 'delete' && Number.isSafeInteger(op.count)));
}

function isCollaborationOpsResult(value) {
  if (value?.schemaVersion !== 1 || typeof value.ok !== 'boolean') return false;
  return value.ok
    ? typeof value.text === 'string' && Number.isSafeInteger(value.revision)
    : ['region-not-found', 'expected-text-mismatch', 'unsupported-text', 'invalid-offset']
      .includes(value.reason);
}

function isCollaborationMutation(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Number.isSafeInteger(value.sequence) && value.sequence > 0
    && typeof value.origin === 'string' && value.origin.length > 0
    && typeof value.regionId === 'string' && typeof value.text === 'string';
}

function isBodyStructureRequest(value) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const id = (candidate) => typeof candidate === 'string' && uuid.test(candidate);
  const offset = (candidate) => Number.isSafeInteger(candidate) && candidate >= 0;
  const endpoint = (candidate) => candidate && id(candidate.regionId) && offset(candidate.offset);
  const operation = value?.operation;
  return value && id(value.planId) && operation?.version === 1 && id(operation.epoch)
    && operation.operationId === value.planId && offset(operation.topologyRevision) && offset(operation.durableAck)
    && endpoint(operation.start) && endpoint(operation.end) && typeof operation.text === 'string'
    && operation.text.length <= 200000 && Array.isArray(operation.expectedRevisions)
    && operation.expectedRevisions.length > 0 && operation.expectedRevisions.length <= 500
    && operation.expectedRevisions.every((entry) => id(entry?.regionId) && offset(entry.revision));
}
