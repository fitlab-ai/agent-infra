# .github/scripts/

This template directory is mirrored to downstream projects through the
`.github/scripts/` managed directory wildcard in `.agents/.airc.json`.

Project-specific scripts that do not exist in this template directory should be
declared in `files.ejected`. Otherwise, sync treats them as files removed from
the template and deletes the local project copy.

Example:

```json
{
  "files": {
    "ejected": [
      ".github/scripts/your-project-script.mjs"
    ]
  }
}
```

`ejected` covers both files that a project takes over from the template and
files that only exist in the downstream project. In both cases, sync skips
overwriting them and skips deleting them during managed cleanup.

## 中文

本模板目录会通过 `.agents/.airc.json` 中的 `.github/scripts/` managed 目录通配同步到下游项目。

如果下游项目在此目录新增项目独占脚本，且该脚本不存在于模板目录中，请把它声明到 `files.ejected`。否则同步会把它视为模板已下线文件，并删除项目本地副本。

示例：

```json
{
  "files": {
    "ejected": [
      ".github/scripts/your-project-script.mjs"
    ]
  }
}
```

`ejected` 同时覆盖“项目接管模板文件”和“项目独占文件”两种情况。两者在同步行为上相同：跳过覆盖，也跳过 managed 清理删除。
