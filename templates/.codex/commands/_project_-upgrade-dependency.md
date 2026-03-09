---
description: Upgrade project dependency
argument-hint: <package-name> <from-version> <to-version>
---

Upgrade the specified dependency package in the project to a new version and verify changes.

Example: /upgrade-dependency swagger-ui 5.30.0 5.30.2

Arguments:
- Package name: $1
- Current version: $2
- Target version: $3

Execute the following steps:

1. Find dependency files:
   ```bash
   grep -r "$1" --include="pom.xml" --include="package.json" --include="build.gradle" --include="requirements.txt" .
   grep -r "$2" --include="pom.xml" --include="package.json" --include="build.gradle" --include="requirements.txt" .
   ```

2. Update dependency version:
   Based on project type, update the corresponding dependency file:
   - Maven (pom.xml): Use Edit tool to replace `<version>$2</version>` with `<version>$3</version>`
   - Node.js (package.json): Use Edit tool to update version
   - Gradle (build.gradle): Use Edit tool to update version

3. Update related static resources:
   If the dependency includes static resources (e.g., swagger-ui), sync version references, CDN links, etc.

4. Verify changes:
   ```bash
   git diff
   git diff --name-only | wc -l
   ```
   Build verification:
   ```bash
   mvn clean package -Dmaven.test.skip=true
   ```
   Run tests (recommended):
   ```bash
   mvn test
   ```

5. Output change summary:
   ```
   Dependency upgrade complete
   Package: $1
   Previous: $2
   New: $3
   Changed files: <list>
   Build status: <success/failure>
   Test status: <passed/failed/not run>
   Next step: Please review changes then commit:
   - Claude Code / OpenCode: /commit
   - Gemini CLI: /{project}:commit
   - Codex CLI: /prompts:{project}-commit
   ```

**Notes**:
- Check CHANGELOG and Migration Guide before upgrading
- Watch for Breaking Changes
- Do **NOT** auto-commit (git commit), wait for manual review
- Upgrade one dependency at a time
