# Security Policy

## Supported Versions

Please use the following table to understand which versions are currently supported with security updates.

| Version  | Support Status        |
| -------- | --------------------- |
| v1.0.x   | Supported             |
| < v1.0.0 | Not Supported         |

## Reporting Vulnerabilities

We take security issues very seriously. If you discover a security vulnerability, please follow these steps to report it:

### How to Report

**Please do not report security vulnerabilities in public GitHub issues.**

Instead, please report privately through the following methods:

1. **GitHub Security Advisory** (Recommended)
   - Go to the project's "Security" tab
   - Click "Report a vulnerability"
   - Fill out the security advisory form

### Report Content

Please include the following information in your report:

- **Vulnerability Type**: Briefly describe the nature of the vulnerability
- **Impact Scope**: Affected components, versions, or features
- **Reproduction Steps**: Detailed steps on how to reproduce the vulnerability
- **Proof of Concept**: If possible, provide PoC code or screenshots
- **Impact Assessment**: Potential security impact and risk level
- **Suggested Fix**: If you have fix suggestions, please provide them

### Response Timeline

We commit to responding to security reports according to the following timeline:

- **Acknowledgment**: Within 24 hours
- **Initial Assessment**: Within 72 hours
- **Detailed Analysis**: Within 7 business days
- **Fix Release**: 1-30 days depending on severity

### Vulnerability Severity

We use the following criteria to assess vulnerability severity:

#### Critical
- Remote Code Execution
- Authentication bypass
- Unauthorized access to sensitive data

#### High
- Cross-Site Scripting (XSS)
- Privilege escalation
- Sensitive data exposure

#### Medium
- Information disclosure
- Denial of Service (DoS)
- Weak cryptography

#### Low
- Configuration issues
- Information gathering vulnerabilities

### Handling Process

1. **Report Reception**: We receive your report and acknowledge it
2. **Vulnerability Verification**: Our security team verifies the vulnerability's existence and impact
3. **Impact Assessment**: Assess vulnerability severity and impact scope
4. **Fix Development**: Develop and test fix solutions
5. **Coordinated Release**: Coordinate disclosure timing with reporter
6. **Public Disclosure**: Release security updates and announcements

### Responsible Disclosure

We follow responsible disclosure principles:

- We will publicly disclose after fixing the vulnerability
- Please do not publicly discuss the vulnerability before the fix is released
- We will appropriately thank reporters in security announcements (unless you prefer to remain anonymous)

### Security Update Notifications

To receive security update notifications, please:

1. **Watch this Repository** and enable security alerts
2. **Subscribe to Releases** to get new version notifications

### Security Best Practices

When using this project, we recommend following these security best practices:

- Always use the latest supported version
- Regularly update dependencies
- Enable appropriate logging and monitoring
- Implement the principle of least privilege
- Conduct regular security audits

### Scope

This security policy applies to:

- All code in this GitHub repository
- Official releases

This security policy does NOT apply to:

- Third-party plugins or extensions
- User configuration errors

### Acknowledgments

We thank the following researchers for their contributions to project security:

<!--
Acknowledgment list will be updated here
- [Researcher Name] - Discovered and reported [Vulnerability Type]
-->

---

**Note**: This security policy may be updated regularly. Please check the latest version periodically.

**Last Updated**: March 2026
