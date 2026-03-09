---
name: upgrade-dependency
description: >
  Upgrade a specified dependency package to a new version and verify
  the change. Triggered when the user requests dependency upgrade.
  Arguments: package name, old version, new version.
---

# Upgrade Dependency

Upgrade a dependency package to the specified version with build and test verification.

<!-- TODO: Adapt the commands below to your project's package manager -->

## Execution Flow

### 1. Parse Arguments

Extract from arguments: package name, old version, new version.

### 2. Find Dependency Location

Search for the package in dependency files:
- `package.json` (Node.js)
- `pom.xml` (Maven)
- `requirements.txt` / `pyproject.toml` (Python)
- `go.mod` (Go)
- Other project-specific dependency files

### 3. Update Version

Update the version number in the dependency file.

### 4. Install Dependencies

<!-- TODO: Replace with your project's install command -->
```bash
# npm install          (Node.js)
# mvn clean install    (Maven)
# pip install -r requirements.txt  (Python)
# go mod tidy          (Go)
```

### 5. Verify Build

<!-- TODO: Replace with your project's build command -->
```bash
# npm run build        (Node.js)
# mvn compile          (Maven)
# make build           (generic)
```

### 6. Run Tests

Execute the project's test command. Reference the test skill for the project-specific test command.

### 7. Output Results

Report:
- Files modified
- Build status (pass/fail)
- Test status (pass/fail)
- Any deprecation warnings or breaking changes noticed

Suggest next step: commit the changes.

## Notes

1. **No auto-commit**: Do NOT automatically commit changes
2. **Major version upgrades**: Warn about potential breaking changes
3. **Test failures**: Report the failure details and wait for user decision
4. **Lock files**: If the project uses lock files (package-lock.json, yarn.lock, etc.), ensure they are updated
5. **Transitive dependencies**: Note if the upgrade affects transitive dependencies

## Error Handling

- Package not found: Prompt "Package {name} not found in dependency files"
- Build failure: Output errors and suggest checking for breaking changes
- Test failure: Output test errors and suggest checking migration guide
