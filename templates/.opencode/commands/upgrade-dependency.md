---
name: "upgrade-dependency"
description: "Upgrade dependency package to new version"
usage: "/upgrade-dependency <package-name> <from-version> <to-version>"
---

# Upgrade Dependency Command

## Description

Upgrade the specified dependency package in the project to a new version and verify the changes.

## Usage

```bash
/upgrade-dependency <package-name> <from-version> <to-version>
```

For example:
```bash
/upgrade-dependency swagger-ui 5.30.0 5.30.2
```

## Execution Steps

### 1. Parse Arguments

- **Package name**: First argument
- **Current version**: Second argument
- **Target version**: Third argument

### 2. Find Dependency Files

Use Grep to search for files containing the dependency:

```bash
# Search for package name
grep -r "<package-name>" --include="pom.xml" --include="package.json" --include="build.gradle"

# Search for current version
grep -r "<from-version>" --include="pom.xml" --include="package.json" --include="build.gradle"
```

### 3. Update Dependency Version

Update the corresponding dependency file based on project type:

**Maven project** (pom.xml):
```xml
<!-- From -->
<dependency>
    <groupId>...</groupId>
    <artifactId>{package-name}</artifactId>
    <version>{from-version}</version>
</dependency>

<!-- Update to -->
<dependency>
    <groupId>...</groupId>
    <artifactId>{package-name}</artifactId>
    <version>{to-version}</version>
</dependency>
```

**Node.js project** (package.json):
```json
{
  "dependencies": {
    "{package-name}": "{to-version}"
  }
}
```

**Gradle project** (build.gradle):
```groovy
implementation '{group}:{package-name}:{to-version}'
```

### 4. Update Related Static Resources

If the dependency includes static resources (e.g., swagger-ui HTML/CSS/JS files), update accordingly:
- Version number references
- CDN links
- Version descriptions in documentation

### 5. Verify Changes

#### 5.1 Review Changes

```bash
git diff
```

Confirm changes are correct and no unintended modifications were made.

#### 5.2 Build Verification

```bash
# Maven project
mvn clean package -Dmaven.test.skip=true

# Node.js project
npm install
npm run build

# Gradle project
./gradlew clean build -x test
```

#### 5.3 Run Tests (Recommended)

```bash
# Maven project
mvn test

# Node.js project
npm test

# Gradle project
./gradlew test
```

### 6. Output Change Summary

Inform the user of the upgrade results:

```
Dependency upgrade complete

**Dependency Information**:
- Package: {package-name}
- Previous version: {from-version}
- New version: {to-version}

**Changed Files**:
- {file-path-1}
- {file-path-2}

**Verification Results**:
- Build status: {Success/Failed}
- Test status: {Passed/Failed/Not run}

**Next Steps**:
Please review the changes manually, then commit:
- Claude Code / OpenCode: `/commit`
- Gemini CLI: `/{project}:commit`
- Codex CLI: `/prompts:{project}-commit`
```

## Parameters

- `<package-name>`: Dependency package name (required)
- `<from-version>`: Current version number (required)
- `<to-version>`: Target version number (required)

## Usage Examples

### Example 1: Upgrade Swagger UI

```bash
/upgrade-dependency swagger-ui 5.30.0 5.30.2
```

### Example 2: Upgrade Spring Boot

```bash
/upgrade-dependency spring-boot 2.7.0 2.7.18
```

### Example 3: Upgrade React

```bash
/upgrade-dependency react 18.2.0 18.3.1
```

## Notes

1. **Version Compatibility**:
   - Check CHANGELOG and Migration Guide before upgrading
   - Watch for Breaking Changes
   - Cross-major-version upgrades require extra caution

2. **Dependency Relationships**:
   - Watch for transitive dependency compatibility
   - Some dependencies may need synchronized upgrades
   - Check for dependency conflicts

3. **Verification Testing**:
   - Build verification is required after upgrade
   - Running the full test suite is recommended
   - Check for deprecated API warnings

4. **Manual Review**:
   - Review changes manually after upgrade completion
   - Confirm no unintended configuration changes
   - Only commit after verification

5. **Git Operations**:
   - Do **NOT** automatically execute git commit
   - Wait for manual review before committing
   - Commit message should clearly describe the upgrade

6. **Security Upgrades**:
   - If it's a security vulnerability fix, prioritize handling
   - Note the related CVE or GHSA ID in the commit message

## Related Commands

- `/analyze-dependabot <alert-number>` - Analyze Dependabot alert (for security-related upgrades)
- `/commit` - Commit code
- `/test` - Run tests

## Error Handling

- Dependency file not found: Prompt "No dependency files found containing {package-name}"
- Version not found: Prompt "Version {from-version} not found, please check the current version number"
- Build failure: Prompt "Build failed after upgrade, please check error messages"
- Test failure: Prompt "Tests failed after upgrade, possible compatibility issues"

## Best Practices

1. **Small-step Upgrades**:
   - Upgrade one dependency at a time
   - Avoid upgrading multiple related dependencies simultaneously
   - Perform full verification for each upgrade

2. **Record Changes**:
   - State the upgrade reason in the commit message
   - Link related Issues or security alerts
   - Document important compatibility changes

3. **Rollback Preparation**:
   - Ensure clear git history
   - Know how to rollback to the previous version
   - Document issues and solutions encountered during upgrade
