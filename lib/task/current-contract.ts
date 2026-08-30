import { isValidAgentInfraVersion } from '../version.ts';
import { parseTypedTaskFrontmatter } from './frontmatter.ts';
import { LEDGER_SECTION_MISSING_CODE, LEDGER_SECTION_MISSING_MESSAGE, parseLedgerDocument, validateLedgerRows } from './ledger.ts';
import type { LedgerDocument } from './ledger.ts';

type CurrentTaskContractErrorCode = 'TASK_DOCUMENT_INVALID' | 'TASK_CURRENT_CONTRACT_INVALID';
type CurrentTaskContractResult =
  | {
      ok: true;
      metadata: ReturnType<typeof parseTypedTaskFrontmatter>;
      ledger: LedgerDocument;
    }
  | {
      ok: false;
      code: CurrentTaskContractErrorCode;
      message: string;
    };

function validateCurrentTaskContract(content: string): CurrentTaskContractResult {
  let metadata: ReturnType<typeof parseTypedTaskFrontmatter>;
  try {
    metadata = parseTypedTaskFrontmatter(content);
  } catch (error) {
    return { ok: false, code: 'TASK_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
  if (!isValidAgentInfraVersion(metadata.agent_infra_version)) {
    return {
      ok: false,
      code: 'TASK_CURRENT_CONTRACT_INVALID',
      message: `agent_infra_version must be a valid v-prefixed semver (received ${String(metadata.agent_infra_version ?? 'missing')})`
    };
  }

  let ledger: LedgerDocument;
  try {
    ledger = parseLedgerDocument(content);
  } catch (error) {
    return { ok: false, code: 'TASK_DOCUMENT_INVALID', message: error instanceof Error ? error.message : String(error) };
  }
  if (!ledger.present) {
    return { ok: false, code: 'TASK_CURRENT_CONTRACT_INVALID', message: `${LEDGER_SECTION_MISSING_CODE}: ${LEDGER_SECTION_MISSING_MESSAGE}` };
  }
  const invalid = validateLedgerRows(ledger.rows);
  if (invalid) return { ok: false, code: 'TASK_CURRENT_CONTRACT_INVALID', message: `${invalid.code}: ${invalid.message}` };
  return { ok: true, metadata, ledger };
}

export { validateCurrentTaskContract };
export type { CurrentTaskContractErrorCode, CurrentTaskContractResult };
