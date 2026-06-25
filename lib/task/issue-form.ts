import { parse } from 'yaml';

type TaskFields = {
  title: string;
  description: string;
  requirements: string;
};

// Field id -> task value mapping (single source of truth, per HD-1).
// Only ids that map cleanly to title / description / requirements get a value;
// every other text field gets `N/A`. This deliberately tightens the older
// "suggested" mapping table (impact / context / alternatives / steps / expected
// no longer flow into requirements) so the requirements checklist is never
// pushed into an unrelated field.
const TITLE_IDS = new Set(['summary', 'title']);
const DESCRIPTION_IDS = new Set([
  'description',
  'problem',
  'what-happened',
  'question',
  'current-content',
  'issue-description',
  'detailed-description'
]);
const REQUIREMENTS_IDS = new Set(['requirements', 'solution', 'suggested-content']);

// Only free-text field types carry task content; structural / static fields are skipped.
const TEXT_FIELD_TYPES = new Set(['input', 'textarea']);
const PLACEHOLDER = 'N/A';

function mapFieldValue(id: string, fields: TaskFields): string {
  if (TITLE_IDS.has(id)) return fields.title;
  if (DESCRIPTION_IDS.has(id)) return fields.description;
  if (REQUIREMENTS_IDS.has(id)) return fields.requirements;
  return '';
}

type IssueFormField = {
  type?: unknown;
  id?: unknown;
  attributes?: { label?: unknown };
};

/**
 * Render the final Issue body for a GitHub Issue Form (scenario A).
 *
 * Walks the form's `body[]` in order, skips `markdown` / `dropdown` /
 * `checkboxes`, and renders each `input` / `textarea` as `### {label}` followed
 * by the deterministically-mapped task value (or `N/A` when the field has no
 * reliable source). The template structure is preserved; the whole task.md and
 * its scaffolding sections are never emitted.
 *
 * Throws on unreadable / non-object YAML or a missing `body[]` list so the
 * caller can fall back to the default body.
 */
function renderTemplateBody(formText: string, fields: TaskFields): string {
  const doc = parse(formText) as { body?: unknown } | null;
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.body)) {
    throw new Error('Issue Form has no body[] list');
  }
  const sections: string[] = [];
  for (const raw of doc.body as IssueFormField[]) {
    if (!raw || typeof raw !== 'object') continue;
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (!TEXT_FIELD_TYPES.has(type)) continue;
    const label = typeof raw.attributes?.label === 'string' ? raw.attributes.label.trim() : '';
    if (!label) continue;
    const id = typeof raw.id === 'string' ? raw.id : '';
    const mapped = mapFieldValue(id, fields);
    const value = mapped.trim() === '' ? PLACEHOLDER : mapped;
    sections.push(`### ${label}\n\n${value}`);
  }
  return `${sections.join('\n\n')}\n`;
}

export { renderTemplateBody, mapFieldValue, PLACEHOLDER };
export type { TaskFields };
