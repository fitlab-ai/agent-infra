# Entropy Check Report

- **Report file**: `.agents/workspace/logs/entropy-check/entropy-check-YYYYMMDD-HHMMSS.md`
- **Agent**: {agent}
- **Run time**: {timestamp}

## State Check

```text
$ git status -s
{output}

$ git branch --show-current
{output}

$ date "+%Y-%m-%d %H:%M:%S%:z"
{output}
```

## Review Scope

- {file-or-area} - {why it was inspected}

## Findings Summary

| Severity | Count | Meaning |
|---|---:|---|
| release-blocking | {n} | Must be fixed or manually accepted before release |
| major | {n} | Should be handled soon |
| minor | {n} | Can be scheduled later |
| info | {n} | Observation only |

## Finding Details

### EC-1: {title}

- **Severity**: {release-blocking | major | minor | info}
- **Problem**: {what is wrong}
- **Evidence**: {command and raw output}
- **Impact**: {impact}
- **Recommendation**: {recommendation}
- **Needs human decision**: {yes/no}

## Human Decision Items

### HD-1: {title} [needs-human-decision]

- **Context**: {context}
- **Options**: {options}
- **Impact**: {impact}
- **Recommendation**: {recommendation}

## Follow-up Task Suggestions

- {suggested follow-up task}

## Assumptions

- {assumption}

## Open Questions

- {open question}
