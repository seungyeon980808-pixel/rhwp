import { isUnsupportedLiveFormat } from './collaboration-format-boundary.ts';

/** Resource/structure edits must be saved as an authoritative file checkpoint. */
export function requiresDocumentCheckpoint(command: string): boolean {
  return command.startsWith('table:') && command !== 'table:transpose-copy'
    || isUnsupportedLiveFormat(command, true)
    || command.startsWith('insert:')
    || command.startsWith('page:')
    || command === 'file:page-setup';
}
