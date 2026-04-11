# Copyright Check

Read this file before editing any copyright header.

## Update Copyright Header Years

### Get Current Year

```bash
date +%Y
```

### Check Modified Files

```bash
git status --short
```

### For Each Modified File

Check whether the file contains a copyright header:

```bash
grep "Copyright.*[0-9]\{4\}" <modified_file>
```

If a header exists and the year is outdated, update it using the current year.

Common update patterns:
- `Copyright (C) 2024-2025` -> `Copyright (C) 2024-{CURRENT_YEAR}`
- `Copyright (C) 2024` -> `Copyright (C) 2024-{CURRENT_YEAR}`
- `Copyright (C) 2025` -> `Copyright (C) {CURRENT_YEAR}` when the file already uses the current year

### Copyright Checklist

- [ ] Use `date +%Y`
- [ ] Check every modified file
- [ ] Update only modified files
- [ ] Never hardcode the current year
