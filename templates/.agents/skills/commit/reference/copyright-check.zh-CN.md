# 版权检查

在修改任何版权头之前先读取本文件。

## 更新版权头年份（关键）

### 获取当前年份

```bash
date +%Y
```

### 检查已修改文件

```bash
git status --short
```

### 对每个已修改文件执行

检查文件是否包含版权头：

```bash
grep "Copyright.*[0-9]\{4\}" <modified_file>
```

如果存在版权头且年份已过期，必须使用当前年份更新。

常见更新模式：
- `Copyright (C) 2024-2025` -> `Copyright (C) 2024-{CURRENT_YEAR}`
- `Copyright (C) 2024` -> `Copyright (C) 2024-{CURRENT_YEAR}`
- `Copyright (C) 2025` -> 如果文件已经使用当前年份，则更新为 `Copyright (C) {CURRENT_YEAR}`

### 版权检查清单

- [ ] 使用 `date +%Y`
- [ ] 检查每一个已修改文件
- [ ] 只更新已修改文件
- [ ] 绝对不要硬编码当前年份
