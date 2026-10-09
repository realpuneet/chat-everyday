# India compliance checklist (starting point)

> **This is not legal advice.** It is an engineering checklist compiled to help you brief a lawyer. Statute numbers and timelines change; rules may have been amended after this was written. **Have a cyber-law / data-protection lawyer review the product, Terms, Privacy Policy, grievance mechanism and operating procedures before launch.**

## 1. Information Technology Act, 2000 ("IT Act") – content offences

| Provision | Why it matters here | Where the product responds |
|---|---|---|
| s.67 – publishing/transmitting obscene material | Adult chat/images need clear consent-based boundaries, 18+ gating, blur-by-default, room-level adult flag | adult flag + age levels, blur/tap-to-reveal, reports, takedown |
| s.67A – sexually explicit act/conduct | Same, stricter penalties | same; hash + NSFW hooks; admin takedown |
| s.67B – child sexual abuse material | Zero tolerance; reporting obligations | hard blocks (code-enforced), immediate ban, hash-match hook, escalation procedure (§5) |
| s.66E – violation of privacy (capturing/publishing private images) | non-consensual intimate imagery | `nonconsensual` report category, 24 h takedown target, view-once/timers, watermark, no downloads |
| s.66C / 66D – identity theft / cheating by personation | impersonation reports | `impersonation` takedown category, ban evasion controls |
| s.69A – blocking orders | Government blocking directions must be actionable | admin takedown + audit log; designate a nodal contact |
| s.79 – intermediary safe harbour | Conditional on due diligence under the 2021 Rules | everything in §2 |

## 2. IT (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021

- [ ] Publish Terms/Rules + Privacy Policy prominently (Rule 3(1)(a)-(b)); inform users not to host/share unlawful content (done as placeholders: `/terms`, `/privacy`).
- [ ] **Grievance Officer**: appoint a resident officer, publish name + contact + mechanism (Rule 3(2)); **acknowledge within 24 hours, resolve within 15 days** (page `/grievance`, takedown queue tracks `dueAt`).
- [ ] **Non-consensual intimate imagery / impersonation in sexual nature**: remove or disable access **within 24 hours** of a complaint (Rule 3(2)(b)); `nonconsensual`/`csam` takedowns are created with a 24 h due date and are flagged OVERDUE in the admin UI.
- [ ] Remove unlawful content within **36 hours** of a court order / appropriate government notification (Rule 3(1)(d)); keep the order in the audit trail.
- [ ] Preserve information/records for the statutory period (commonly 180 days) when content is removed; assist authorities with information when lawfully requested (Rule 3(1)(g)/(j) – confirm timelines, usually 72 h).
- [ ] Periodic reminder to users about rules (at least annually) – send an in-app notice.
- [ ] Check whether you will become a **significant social media intermediary** (threshold by registered users) – extra duties (Chief Compliance Officer, nodal contact, monthly reports, traceability for messaging services, voluntary user verification).
- [ ] Note: the 18+ gate, reporting, blocking and moderation tooling are the "reasonable efforts"/due-diligence artefacts you will want to demonstrate.

## 3. Digital Personal Data Protection Act, 2023 (phone numbers, emails, device data)

- [ ] Identify your role: **data fiduciary** (and whether you may be a *significant* data fiduciary → DPO, audits, DPIA).
- [ ] **Notice + consent** before processing (s.5-6): purposes, data list, how to withdraw, grievance route, rights. Consent must be free, specific, informed, unambiguous; keep consent records.
- [ ] **Minimise & limit purpose.** Already: phone stored only as HMAC + last 4 digits; DOB not stored; IP/device only as HMAC for abuse prevention; chats not stored.
- [ ] **Retention/erasure** (s.8(7)): define periods (reports, audit logs, saved chats 30 d default, bans). Implement account deletion and data-export processes (`savedchats` delete exists; add full account erasure before launch).
- [ ] **Data principal rights** (access, correction, erasure, grievance, nomination; s.11-14): define request handling + timelines.
- [ ] **Children (s.9):** the service is 18+ only and must not knowingly process children's data; keep the age gate/ban-on-minor-signal evidence; do not track/target minors.
- [ ] **Security safeguards & breach notification** (s.8(5)-(6)): notify the Board and affected users; keep an incident runbook.
- [ ] **Processors/cross-border:** list SMS, storage, moderation, hosting vendors; contracts; check any restrictions notified on transfers (s.16).
- [ ] Track the DPDP **Rules** and their phased commencement dates.

## 4. Other items to review with counsel

- **SMS in India:** TRAI/DLT registration (principal entity, sender ID/header, **content template**, consent) is mandatory before OTP SMS is delivered; MSG91/Twilio onboarding needs it. Budget lead time.
- **CERT-In directions (2022):** incident reporting within 6 hours, log retention (180 days) and NTP time sync obligations may apply.
- **Criminal law references** (Bharatiya Nyaya Sanhita, POCSO Act 2012 incl. reporting duty): extortion/sextortion, stalking, voyeurism, criminal intimidation, offences against children. Know who in your organisation files reports and when.
- **App stores / hosting / payment partners:** Google Play and Apple have strict user-generated-content and adult-content rules (report + block + moderation are required; sexual content is heavily restricted). Many hosting, CDN, storage and SMS providers prohibit or restrict adult content. **Read each provider's acceptable-use / adult-content policy before choosing it.**
- **Advertising / minors / gambling** are out of scope here.
- Terms: governing law, jurisdiction, liability, indemnity, DMCA-style copyright handling.

## 5. Escalation procedure for CSAM / minor-safety signals (draft for your SOP)

1. The system rejects/blocks, bans permanently (account + device + IP + linked identities), ends the session and raises a **critical** report. Image material is **not retained**: only SHA-256, perceptual hash and metadata are kept in the report/audit log.
2. A trained moderator reviews within your SLA (suggest < 1 hour). Reviewers must not copy, forward or store the material outside the tooling.
3. Counsel decides on the report to the authorities (e.g. via the national cybercrime reporting portal / police; consider the NCMEC CyberTipline if you use US-based infrastructure that mandates it). Preserve logs and hashes for the statutory period.
4. Add confirmed hashes to the blocklist (admin takedown does this when `hide_content` is used on CSAM/NCII categories).
5. Record every step in the audit log; review false-positive appeals through the Grievance Officer.

## 6. Pages to finalise before launch

`/terms`, `/privacy`, `/grievance`, `/takedown` ship as **clearly-marked placeholder text**. Replace `[PLACEHOLDERS]` (entity, address, officer, retention periods, vendors) with reviewed content.
