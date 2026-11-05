# Explicit-content screening and medical access

## What this change provides

- A conservative, text-based screening helper for extracted study text.
- Strong phrase signals are used; isolated clinical anatomy and reproductive-health terms are not treated as pornography.
- Materials with strong signals in an educational/clinical context are sent to manual review rather than automatically blocked.
- A separate authorization helper makes the access rule explicit: restricted material is accessible only when the user's medical status has been verified.

## Verification is not self-assertion

A student must not become medically verified merely by typing a medical email address or selecting "Medical" in a form. A production verification workflow should:
1. Collect institution, medical program, and expected graduation year.
2. Verify control of an institution-issued email using a one-time code.
3. Request a current student ID/card for manual review by an authorized reviewer (or integrate a trusted verification provider).
4. Store only the verification status, reviewer, timestamp, and minimal audit metadata. Avoid retaining ID images after review.
5. Require re-verification when the status expires or the institution/program changes.

A matching educational email is supporting evidence, not proof of enrollment. Do not grant privileges based solely on a user-controlled email domain.

## Important limitations

This helper screens extracted text only. It does not inspect embedded images, scanned pages without OCR, audio, or video frames, and it is not a production-grade pornography classifier. OCR/image moderation, file-size limits, malware scanning, quarantine storage, human review, persistence, frontend workflows, and access checks for every content-read/download endpoint are required before deployment.

The initial API integration must remain fail-closed for uploads that cannot be screened. Do not use this heuristic to make legal or disciplinary determinations.
