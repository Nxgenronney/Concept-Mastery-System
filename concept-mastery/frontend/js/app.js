/**
 * Concept Mastery Platform - Application Engine
 * Orchestrates views, state, KaTeX math formatting, and backend integrations.
 */

(function() {
  // Application State
  const AppState = {
    currentRoute: "dashboard",
    currentUser: (typeof ApiService !== "undefined" && typeof ApiService.getUser === "function") ? ApiService.getUser() : null,
    activeDoc: null,
    masteryList: [],
    recommendations: [],
    graphData: null,
    loopStatus: null,
    baselineCompleted: false,
    activeRecallSession: null,
    studentName: (typeof ApiService !== "undefined" && typeof ApiService.getUser === "function" && ApiService.getUser() && ApiService.getUser().full_name) || localStorage.getItem("cm_student_name") || "Guest Student",
    chatMessages: [
      {
        sender: "assistant",
        text: "Hello! I am your AI Study Tutor. Ask me any question about your study material, or select a topic to get started.",
        citations: []
      }
    ],
    quizSession: {
      active: false,
      currentQuestion: null,
      currentIndex: 1,
      totalQuestions: 6,
      score: 0,
      history: [],
      targetConceptId: null,
      currentConceptId: null,
      seenQuestionIds: new Set(),
      remedialMode: false
    },
    smartNotes: {
      selectedTask: null,
      activeNote: null,
      savedNotes: [],
      selectedConceptId: null,
      customInstructions: "",
      diagramSvg: null,
      activeAudioUrl: null
    }
  };

  // Helper DOM Selectors
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  // ── Multi-Agent Pedagogical Assessment ApiService Methods ──────────────────
  if (typeof ApiService !== "undefined") {
    ApiService.evaluateEvidence = async function(evidenceData) {
      const base = typeof getEffectiveBase === "function" ? getEffectiveBase() : "";
      const authToken = typeof ApiService.getToken === "function" ? ApiService.getToken() : null;
      const headers = { "Content-Type": "application/json" };
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
      const res = await fetch(`${base}/api/mastery/evaluate-evidence`, {
        method: "POST",
        headers,
        body: JSON.stringify(evidenceData)
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `evaluateEvidence failed with status ${res.status}`);
      }
      return await res.json();
    };

    ApiService.getConceptDeliberation = async function(conceptId, userId) {
      const base = typeof getEffectiveBase === "function" ? getEffectiveBase() : "";
      const authToken = typeof ApiService.getToken === "function" ? ApiService.getToken() : null;
      const headers = {};
      if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
      const uid = userId || getCurrentUserId();
      const url = `${base}/api/mastery/${encodeURIComponent(conceptId)}/deliberation?user_id=${encodeURIComponent(uid)}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `getConceptDeliberation failed with status ${res.status}`);
      }
      return await res.json();
    };

    if (typeof window !== "undefined" && window.ApiService) {
      window.ApiService.evaluateEvidence = ApiService.evaluateEvidence;
      window.ApiService.getConceptDeliberation = ApiService.getConceptDeliberation;
    }
  }

  // ── Multi-Agent Qualitative Outcome Badges ─────────────────────────────────
  function getQualitativeOutcome(c) {
    if (c && c.outcome) {
      if (c.outcome === "MASTERED") return "MASTERED";
      if (c.outcome === "NOT_YET_MASTERED") return "NOT_YET_MASTERED";
      if (c.outcome === "INSUFFICIENT_EVIDENCE") return "INSUFFICIENT_EVIDENCE";
    }
    const st = typeof getConceptStatus === "function" ? getConceptStatus(c) : (c.status || c.state || "").toLowerCase();
    if (st === "strong") return "MASTERED";
    if (st === "weak") return "NOT_YET_MASTERED";
    return "INSUFFICIENT_EVIDENCE";
  }

  function renderOutcomeBadge(c) {
    const outcome = getQualitativeOutcome(c);
    if (outcome === "MASTERED") {
      return `<span class="outcome-badge outcome-mastered" style="background:#10b981; color:#ffffff; font-weight:700; font-size:0.75rem; padding:0.25rem 0.65rem; border-radius:9999px; letter-spacing:0.04em; display:inline-flex; align-items:center; gap:0.25rem;">MASTERED</span>`;
    }
    if (outcome === "NOT_YET_MASTERED") {
      return `<span class="outcome-badge outcome-not-yet" style="background:#f43f5e; color:#ffffff; font-weight:700; font-size:0.75rem; padding:0.25rem 0.65rem; border-radius:9999px; letter-spacing:0.04em; display:inline-flex; align-items:center; gap:0.25rem;">NOT YET MASTERED</span>`;
    }
    return `<span class="outcome-badge outcome-insufficient" style="background:#64748b; color:#ffffff; font-weight:700; font-size:0.75rem; padding:0.25rem 0.65rem; border-radius:9999px; letter-spacing:0.04em; display:inline-flex; align-items:center; gap:0.25rem;">NEEDS EVIDENCE</span>`;
  }

  // ── Multi-Agent Teacher Deliberation Modal Controller ───────────────────────
  async function openTeacherDeliberationModal(conceptId, conceptName) {
    const modal = $("#modal-teacher-deliberation");
    const title = $("#deliberation-modal-title");
    const subtitle = $("#deliberation-modal-subtitle");
    const body = $("#modal-teacher-deliberation-body");
    if (!modal || !body) return;

    if (title) title.textContent = conceptName || conceptId;
    if (subtitle) subtitle.textContent = "Multi-Agent Pedagogical Deliberation · 4 Specialist Teachers + Head Teacher Arbiter";

    body.innerHTML = `
      <div style="text-align:center; padding:3rem 1rem;">
        <span class="upload-icon-pulse" style="width:28px; height:28px; border:3px solid var(--primary); border-top-color:transparent; border-radius:50%; display:inline-block; animation:spin 1s linear infinite;"></span>
        <p style="margin-top:1rem; color:var(--ink-secondary); font-size:0.92rem;">
          Consulting 4 Specialist Teachers and deliberating Head Teacher Arbiter decision for <strong>${esc(conceptName || conceptId)}</strong>...
        </p>
      </div>
    `;

    if (typeof modal.showModal === "function") modal.showModal();
    else modal.setAttribute("open", "");

    try {
      const uid = getCurrentUserId();
      const res = await ApiService.getConceptDeliberation(conceptId, uid);
      const decision = res.decision;
      const findings = res.specialist_findings || [];
      const evidence = res.evidence_records || [];

      const teacherFinding = findings.find(f => f.agent_role === "teaching_agent");
      const assessmentFinding = findings.find(f => f.agent_role === "assessment_agent");
      const misconceptionFinding = findings.find(f => f.agent_role === "misconception_detective");
      const observerFinding = findings.find(f => f.agent_role === "learning_observer");

      const outcome = decision ? decision.outcome : "INSUFFICIENT_EVIDENCE";
      const outcomeBadge = renderOutcomeBadge({ outcome });

      body.innerHTML = `
        <!-- Top Summary Banner -->
        <div style="background:var(--surface-subtle, #f8fafc); border:1px solid var(--border-subtle, #e2e8f0); border-radius:12px; padding:1.25rem; margin-bottom:1.5rem;">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.75rem; margin-bottom:0.75rem;">
            <div>
              <span style="font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; color:var(--ink-muted); font-weight:700;">Head Teacher Arbiter Verdict</span>
              <h2 style="margin:0.25rem 0 0 0; font-size:1.35rem; font-weight:800; color:var(--ink-primary);">${esc(conceptName || conceptId)}</h2>
            </div>
            <div>
              ${outcomeBadge}
            </div>
          </div>

          <p style="font-size:0.95rem; line-height:1.55; color:var(--ink-primary); margin:0 0 1rem 0; font-weight:500;">
            ${esc(decision && decision.explainable_summary ? decision.explainable_summary : "No prior deliberation recorded. Complete learning interactions or submit evidence to initiate multi-agent assessment.")}
          </p>

          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:1rem;">
            <!-- Demonstrated Understanding -->
            <div style="background:#fff; border:1px solid var(--border-subtle, #e2e8f0); border-radius:8px; padding:0.85rem 1rem;">
              <div style="font-size:0.78rem; font-weight:700; color:#10b981; text-transform:uppercase; margin-bottom:0.4rem; display:flex; align-items:center; gap:0.35rem;">
                <span>✓</span> Demonstrated Understanding
              </div>
              ${decision && decision.demonstrated_understanding && decision.demonstrated_understanding.length > 0 ? `
                <ul style="margin:0; padding-left:1.2rem; font-size:0.85rem; color:var(--ink-primary); line-height:1.45;">
                  ${decision.demonstrated_understanding.map(u => `<li>${esc(u)}</li>`).join("")}
                </ul>
              ` : `
                <span style="font-size:0.82rem; color:var(--ink-muted);">None demonstrated yet.</span>
              `}
            </div>

            <!-- Remaining Gaps -->
            <div style="background:#fff; border:1px solid var(--border-subtle, #e2e8f0); border-radius:8px; padding:0.85rem 1rem;">
              <div style="font-size:0.78rem; font-weight:700; color:#f43f5e; text-transform:uppercase; margin-bottom:0.4rem; display:flex; align-items:center; gap:0.35rem;">
                <span>⚠</span> Remaining Gaps &amp; Misconceptions
              </div>
              ${decision && decision.remaining_gaps && decision.remaining_gaps.length > 0 ? `
                <ul style="margin:0; padding-left:1.2rem; font-size:0.85rem; color:var(--ink-primary); line-height:1.45;">
                  ${decision.remaining_gaps.map(g => `<li>${esc(g)}</li>`).join("")}
                </ul>
              ` : `
                <span style="font-size:0.82rem; color:var(--ink-muted);">No remaining gaps identified.</span>
              `}
            </div>
          </div>

          ${decision && decision.recommended_next_action ? `
            <div style="margin-top:1rem; padding:0.75rem 1rem; background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; display:flex; align-items:center; gap:0.6rem; font-size:0.88rem; color:#1e40af;">
              <span style="font-weight:700;">🎯 Recommended Next Action:</span>
              <span>${esc(decision.recommended_next_action)}</span>
            </div>
          ` : ''}

          ${decision && decision.follow_up_question ? `
            <div style="margin-top:0.75rem; padding:0.75rem 1rem; background:#fffbeb; border:1px solid #fef3c7; border-radius:8px; font-size:0.88rem; color:#92400e;">
              <div style="font-weight:700; margin-bottom:0.25rem;">Follow-up Cognitive Probe:</div>
              <div>${esc(decision.follow_up_question.question_text || '')}</div>
            </div>
          ` : ''}
        </div>

        <!-- 4 Specialist Teacher Cards -->
        <div style="margin-bottom:1.5rem;">
          <h4 style="font-size:1rem; font-weight:700; margin-bottom:0.75rem; color:var(--ink-primary); display:flex; align-items:center; gap:0.4rem;">
            <span>👥</span> 4 Specialist Pedagogical Teachers
          </h4>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap:1rem;">
            
            <!-- 1. Teaching Agent -->
            <div class="card" style="margin:0; padding:1.15rem; border-top:3px solid #3b82f6;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.5rem;">
                <div>
                  <h4 style="margin:0; font-size:0.95rem; font-weight:700;">👩‍🏫 Teaching Agent</h4>
                  <span style="font-size:0.76rem; color:var(--ink-muted);">Conceptual comprehension &amp; in-own-words synthesis</span>
                </div>
                <span style="font-size:0.72rem; padding:0.15rem 0.45rem; border-radius:4px; background:#eff6ff; color:#2563eb; font-weight:600;">
                  ${teacherFinding ? esc(teacherFinding.assessment_confidence) : 'pending'}
                </span>
              </div>
              <p style="font-size:0.84rem; line-height:1.45; color:var(--ink-primary); margin:0 0 0.5rem 0;">
                ${teacherFinding ? esc(teacherFinding.findings) : "Awaiting student interactions on this concept."}
              </p>
              ${teacherFinding && teacherFinding.recommended_action ? `
                <div style="font-size:0.78rem; color:var(--ink-secondary);">
                  <strong>Action:</strong> ${esc(teacherFinding.recommended_action)}
                </div>
              ` : ''}
            </div>

            <!-- 2. Assessment Agent -->
            <div class="card" style="margin:0; padding:1.15rem; border-top:3px solid #8b5cf6;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.5rem;">
                <div>
                  <h4 style="margin:0; font-size:0.95rem; font-weight:700;">🎯 Assessment Agent</h4>
                  <span style="font-size:0.76rem; color:var(--ink-muted);">Independent testing &amp; cognitive forms</span>
                </div>
                <span style="font-size:0.72rem; padding:0.15rem 0.45rem; border-radius:4px; background:#f5f3ff; color:#7c3aed; font-weight:600;">
                  ${assessmentFinding ? esc(assessmentFinding.assessment_confidence) : 'pending'}
                </span>
              </div>
              <p style="font-size:0.84rem; line-height:1.45; color:var(--ink-primary); margin:0 0 0.5rem 0;">
                ${assessmentFinding ? esc(assessmentFinding.findings) : "Awaiting student assessment probes."}
              </p>
              ${assessmentFinding && assessmentFinding.recommended_action ? `
                <div style="font-size:0.78rem; color:var(--ink-secondary);">
                  <strong>Action:</strong> ${esc(assessmentFinding.recommended_action)}
                </div>
              ` : ''}
            </div>

            <!-- 3. Misconception Detective -->
            <div class="card" style="margin:0; padding:1.15rem; border-top:3px solid #f43f5e;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.5rem;">
                <div>
                  <h4 style="margin:0; font-size:0.95rem; font-weight:700;">🕵️ Misconception Detective</h4>
                  <span style="font-size:0.76rem; color:var(--ink-muted);">Flawed mental models &amp; contradictions</span>
                </div>
                <span style="font-size:0.72rem; padding:0.15rem 0.45rem; border-radius:4px; background:#fff1f2; color:#e11d48; font-weight:600;">
                  ${misconceptionFinding ? esc(misconceptionFinding.assessment_confidence) : 'pending'}
                </span>
              </div>
              <p style="font-size:0.84rem; line-height:1.45; color:var(--ink-primary); margin:0 0 0.5rem 0;">
                ${misconceptionFinding ? esc(misconceptionFinding.findings) : "No active misconceptions detected."}
              </p>
              ${misconceptionFinding && misconceptionFinding.recommended_action ? `
                <div style="font-size:0.78rem; color:var(--ink-secondary);">
                  <strong>Action:</strong> ${esc(misconceptionFinding.recommended_action)}
                </div>
              ` : ''}
            </div>

            <!-- 4. Learning Observer -->
            <div class="card" style="margin:0; padding:1.15rem; border-top:3px solid #10b981;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:0.5rem;">
                <div>
                  <h4 style="margin:0; font-size:0.95rem; font-weight:700;">📈 Learning Observer</h4>
                  <span style="font-size:0.76rem; color:var(--ink-muted);">Longitudinal progress &amp; persistence</span>
                </div>
                <span style="font-size:0.72rem; padding:0.15rem 0.45rem; border-radius:4px; background:#ecfdf5; color:#059669; font-weight:600;">
                  ${observerFinding ? esc(observerFinding.assessment_confidence) : 'pending'}
                </span>
              </div>
              <p style="font-size:0.84rem; line-height:1.45; color:var(--ink-primary); margin:0 0 0.5rem 0;">
                ${observerFinding ? esc(observerFinding.findings) : "Tracking longitudinal learning trajectory."}
              </p>
              ${observerFinding && observerFinding.recommended_action ? `
                <div style="font-size:0.78rem; color:var(--ink-secondary);">
                  <strong>Action:</strong> ${esc(observerFinding.recommended_action)}
                </div>
              ` : ''}
            </div>

          </div>
        </div>

        <!-- Supporting Evidence Records Section -->
        <div>
          <h4 style="font-size:1rem; font-weight:700; margin-bottom:0.75rem; color:var(--ink-primary); display:flex; align-items:center; gap:0.4rem;">
            <span>📝</span> Cited Student Evidence Records (${evidence.length})
          </h4>
          ${evidence.length === 0 ? `
            <div style="padding:1.5rem; text-align:center; background:var(--surface-subtle, #f8fafc); border-radius:8px; border:1px dashed var(--border-subtle, #e2e8f0); color:var(--ink-muted); font-size:0.88rem;">
              No student evidence records recorded for this concept yet. Start a quiz or answer questions to generate evidence.
            </div>
          ` : `
            <div style="display:flex; flex-direction:column; gap:0.75rem;">
              ${evidence.map(ev => `
                <div style="background:#fff; border:1px solid var(--border-subtle, #e2e8f0); border-radius:8px; padding:0.9rem 1.1rem;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem; flex-wrap:wrap; gap:0.5rem;">
                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      <span style="font-family:monospace; font-size:0.78rem; background:#f1f5f9; padding:0.15rem 0.45rem; border-radius:4px; color:#475569;">
                        ${esc(ev.evidence_id || '')}
                      </span>
                      <span style="font-size:0.78rem; text-transform:uppercase; font-weight:700; color:#2563eb;">
                        ${esc(ev.question_form || 'quiz')}
                      </span>
                    </div>
                    <div style="display:flex; align-items:center; gap:0.4rem;">
                      ${ev.hints_used > 0 ? `
                        <span style="font-size:0.74rem; background:#fef3c7; color:#b45309; padding:0.15rem 0.45rem; border-radius:4px; font-weight:600;">
                          ${ev.hints_used} hint(s) used
                        </span>
                      ` : `
                        <span style="font-size:0.74rem; background:#f0fdf4; color:#15803d; padding:0.15rem 0.45rem; border-radius:4px; font-weight:600;">
                          0 hints (unassisted)
                        </span>
                      `}
                      ${ev.solution_revealed_first ? `
                        <span style="font-size:0.74rem; background:#fee2e2; color:#b91c1c; padding:0.15rem 0.45rem; border-radius:4px; font-weight:600;">
                          Solution revealed first
                        </span>
                      ` : ''}
                    </div>
                  </div>

                  ${ev.question_text ? `
                    <div style="font-size:0.85rem; color:var(--ink-secondary); margin-bottom:0.35rem;">
                      <strong>Q:</strong> ${esc(ev.question_text)}
                    </div>
                  ` : ''}

                  <div style="font-size:0.88rem; color:var(--ink-primary); margin-bottom:0.25rem;">
                    <strong>Student Answer:</strong> "${esc(ev.student_answer || '')}"
                  </div>

                  ${ev.student_explanation ? `
                    <div style="font-size:0.82rem; color:var(--ink-secondary); font-style:italic;">
                      <strong>Explanation:</strong> "${esc(ev.student_explanation)}"
                    </div>
                  ` : ''}
                </div>
              `).join("")}
            </div>
          `}
        </div>
      `;
    } catch (err) {
      body.innerHTML = `
        <div style="padding:2rem; text-align:center; color:#ef4444;">
          <p style="font-weight:700;">Failed to load teacher deliberation</p>
          <p style="font-size:0.85rem;">${esc(err.message || String(err))}</p>
          <button class="btn btn-secondary btn-sm" onclick="document.getElementById('modal-teacher-deliberation').close()">Close</button>
        </div>
      `;
    }
  }

  // HTML Entity Escaping
  function esc(str) {
    if (str === null || str === undefined) return "";
    return String(str).replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  // Trigger file download via Blob / temporary anchor
  async function triggerBrowserDownload(url, filename = "") {
    if (!url) return;
    const safeFilename = filename || url.split("/").pop().split("?")[0] || "download";
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = blobUrl;
      a.download = safeFilename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      }, 1000);
    } catch (err) {
      console.warn("Direct blob download failed, falling back to anchor:", err);
      const a = document.createElement("a");
      a.style.display = "none";
      a.href = url;
      a.download = safeFilename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) document.body.removeChild(a);
      }, 500);
    }
  }

  function parseTimestampToSeconds(ts) {
    if (!ts) return 0;
    const clean = String(ts).replace(/[\[\]]/g, "").trim();
    const parts = clean.split(":").map(Number);
    if (parts.length === 2) {
      return (parts[0] || 0) * 60 + (parts[1] || 0);
    } else if (parts.length === 3) {
      return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
    }
    return 0;
  }

  function formatSecondsToTimestamp(sec) {
    const s = Math.max(0, parseInt(sec, 10) || 0);
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  // Format grounded citation tags inside text
  function formatGroundedCitations(text) {
    if (!text) return "";
    let out = text.replace(/\[(Page|Slide|Section)\s+([^\]]+)\]/gi, (match, type, loc) => {
      const cleanLoc = esc(loc.trim());
      const cleanType = esc(type);
      return `<button class="grounded-citation-chip view-citation-chip" data-loc="${cleanLoc}" data-type="${cleanType}" type="button">📖 ${cleanType} ${cleanLoc}</button>`;
    });
    out = out.replace(/\[(?:Video\s+)?(\d{1,2}:\d{2}(?::\d{2})?)\]/gi, (match, ts) => {
      const cleanTs = esc(ts.trim());
      const sec = parseTimestampToSeconds(cleanTs);
      return `<button class="timestamp-citation-chip view-timestamp-chip" data-seconds="${sec}" data-timestamp="${cleanTs}" type="button">▶ [${cleanTs}]</button>`;
    });
    return out;
  }

  window.jumpYouTubePlayerToSeconds = function(seconds, videoId) {
    const sec = parseInt(seconds, 10);
    if (isNaN(sec)) return;

    const iframe = document.getElementById("youtube-player-iframe");
    if (iframe) {
      try {
        iframe.contentWindow.postMessage(JSON.stringify({
          event: "command",
          func: "seekTo",
          args: [sec, true]
        }), "*");
        iframe.contentWindow.postMessage(JSON.stringify({
          event: "command",
          func: "playVideo",
          args: []
        }), "*");
      } catch (err) {}

      // Fallback reload if API didn't connect or player needs to jump
      const currSrc = iframe.src || "";
      if (videoId && !currSrc.includes(`start=${sec}`)) {
        iframe.src = `https://www.youtube.com/embed/${videoId}?start=${sec}&autoplay=1&enablejsapi=1`;
      }
    }

    // Highlight row in transcript list
    document.querySelectorAll(".transcript-row").forEach(row => {
      const rSec = parseInt(row.getAttribute("data-seconds"), 10);
      if (!isNaN(rSec) && Math.abs(rSec - sec) < 60) {
        row.classList.add("active-row");
        row.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } else {
        row.classList.remove("active-row");
      }
    });
  };

  window.openVideoPreviewAtTimestamp = async function(targetSeconds, targetMatId = null) {
    const previewModal = $("#material-preview-modal");
    if (!previewModal) return;

    let matId = targetMatId;
    if (!matId) {
      const mats = AppState.materials || [];
      const ytMat = mats.find(m => (m.source_type || "").toLowerCase() === "youtube");
      if (ytMat) matId = ytMat.material_id;
    }

    if (!matId && AppState.activeDoc && AppState.activeDoc.source_type === "youtube") {
      matId = AppState.activeDoc.material_id;
    }

    // Check if modal is already open with youtube player
    const existingIframe = document.getElementById("youtube-player-iframe");
    if (previewModal.open && existingIframe) {
      window.jumpYouTubePlayerToSeconds(targetSeconds);
      return;
    }

    if (!matId) {
      showToast(`Timestamp [${formatSecondsToTimestamp(targetSeconds)}] referenced. Upload or select a YouTube lecture to view embedded playback.`, "info");
      return;
    }

    try {
      const preview = await ApiService.getMaterialPreview(matId);
      const previewModalTitle = $("#preview-modal-title");
      const previewModalBadge = $("#preview-modal-type-badge");
      const previewModalBody = $("#preview-modal-body");

      if (previewModalTitle) previewModalTitle.textContent = preview.title || "Material Preview";
      if (previewModalBadge) {
        previewModalBadge.textContent = "YOUTUBE";
        previewModalBadge.className = "material-type-badge badge-youtube";
      }

      const items = Array.isArray(preview.structured_preview) ? preview.structured_preview : [];
      const videoId = items[0]?.video_id || "";

      if (previewModalBody) {
        previewModalBody.innerHTML = `
          <div class="youtube-split-viewer">
            <div class="video-player-frame">
              ${videoId ? `
                <iframe id="youtube-player-iframe" src="https://www.youtube.com/embed/${esc(videoId)}?start=${targetSeconds}&autoplay=1&enablejsapi=1" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
              ` : `
                <div style="display:flex; align-items:center; justify-content:center; height:100%; color:#fff;">No video stream available</div>
              `}
            </div>
            <div class="youtube-transcript-list" id="youtube-transcript-list">
              <h4 style="margin:0 0 0.5rem 0; font-size:0.95rem; color:var(--ink-primary);">Timestamped Transcript (${items.length} segments across full duration)</h4>
              ${items.map(it => {
                const ts = it.label || it.timestamp || "00:00";
                const sec = it.start_seconds !== undefined ? it.start_seconds : parseTimestampToSeconds(ts);
                const isActive = Math.abs(sec - targetSeconds) < 60 ? "active-row" : "";
                return `
                  <div class="transcript-row ${isActive}" data-seconds="${sec}" data-video-id="${esc(videoId)}">
                    <span class="transcript-ts-badge">[${esc(ts)}]</span>
                    <span>${esc(it.text)}</span>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        `;

        previewModalBody.querySelectorAll(".transcript-row").forEach(r => {
          r.onclick = () => {
            const sec = parseInt(r.getAttribute("data-seconds"), 10);
            const vid = r.getAttribute("data-video-id");
            if (!isNaN(sec)) {
              window.jumpYouTubePlayerToSeconds(sec, vid);
            }
          };
        });
      }

      previewModal.showModal();
      setTimeout(() => window.jumpYouTubePlayerToSeconds(targetSeconds, videoId), 400);
    } catch (err) {
      showToast(`Could not open video preview: ${err.message}`, "danger");
    }
  };

  // Markdown renderer for Smart Notes
  function formatMarkdownNotes(mdText) {
    if (!mdText) return "";
    let html = "";
    const lines = mdText.split("\n");
    let inCodeBlock = false;
    let codeBlockContent = "";
    let codeLang = "";
    let inList = false;
    let listType = "";

    function closeList() {
      if (inList) {
        html += (listType === "ul" ? "</ul>" : "</ol>");
        inList = false;
      }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code blocks
      if (line.trim().startsWith("```")) {
        if (!inCodeBlock) {
          closeList();
          inCodeBlock = true;
          codeLang = line.trim().slice(3).trim();
          codeBlockContent = "";
        } else {
          inCodeBlock = false;
          html += `<pre><code class="language-${esc(codeLang)}">${esc(codeBlockContent)}</code></pre>`;
        }
        continue;
      }

      if (inCodeBlock) {
        codeBlockContent += (codeBlockContent ? "\n" : "") + line;
        continue;
      }

      // Headers
      if (line.startsWith("# ")) {
        closeList();
        html += `<h1>${formatInlineText(line.slice(2))}</h1>`;
        continue;
      }
      if (line.startsWith("## ")) {
        closeList();
        html += `<h2>${formatInlineText(line.slice(3))}</h2>`;
        continue;
      }
      if (line.startsWith("### ")) {
        closeList();
        html += `<h3>${formatInlineText(line.slice(4))}</h3>`;
        continue;
      }
      if (line.startsWith("#### ")) {
        closeList();
        html += `<h4>${formatInlineText(line.slice(5))}</h4>`;
        continue;
      }

      // Unordered lists
      const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
      if (ulMatch) {
        if (!inList || listType !== "ul") {
          closeList();
          html += "<ul>";
          inList = true;
          listType = "ul";
        }
        html += `<li>${formatInlineText(ulMatch[2])}</li>`;
        continue;
      }

      // Ordered lists
      const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
      if (olMatch) {
        if (!inList || listType !== "ol") {
          closeList();
          html += "<ol>";
          inList = true;
          listType = "ol";
        }
        html += `<li>${formatInlineText(olMatch[2])}</li>`;
        continue;
      }

      // Empty line closes active list
      if (!line.trim()) {
        closeList();
        continue;
      }

      // Paragraph
      closeList();
      html += `<p>${formatInlineText(line)}</p>`;
    }

    closeList();
    if (inCodeBlock) {
      html += `<pre><code>${esc(codeBlockContent)}</code></pre>`;
    }
    return html;
  }

  function formatInlineText(str) {
    if (!str) return "";
    let out = str.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, "$1<em>$2</em>$3");
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = formatGroundedCitations(out);
    return out;
  }

  // Toast Notification
  function showToast(message, type = "info") {
    const container = $("#toast-container");
    if (!container) return;
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${esc(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = "0";
      toast.style.transform = "translateY(10px)";
      setTimeout(() => toast.remove(), 250);
    }, 3200);
  }

  // KaTeX Math Rendering Utility
  function renderMath(element) {
    if (!element) return;
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(element, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
            { left: "\\[", right: "\\]", display: true }
          ],
          throwOnError: false
        });
      } catch (err) {
        console.warn("KaTeX render error:", err);
      }
    }
  }

  // Theme Management
  function initTheme() {
    const savedTheme = localStorage.getItem("cm_theme") || "light";
    applyTheme(savedTheme);

    const toggleBtn = $("#theme-toggle-btn");
    if (toggleBtn) {
      toggleBtn.onclick = () => {
        const current = document.documentElement.getAttribute("data-theme") || "light";
        const next = current === "light" ? "dark" : "light";
        applyTheme(next);
      };
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("cm_theme", theme);
    const sunIcon = $(".sun-icon");
    const moonIcon = $(".moon-icon");
    if (sunIcon && moonIcon) {
      if (theme === "dark") {
        sunIcon.style.display = "block";
        moonIcon.style.display = "none";
      } else {
        sunIcon.style.display = "none";
        moonIcon.style.display = "block";
      }
    }
  }

  // Mobile Menu Navigation
  function initMobileNav() {
    const toggle = $("#mobile-toggle");
    const sidebar = $("#sidebar");
    if (toggle && sidebar) {
      toggle.onclick = () => sidebar.classList.toggle("open");
      document.addEventListener("click", e => {
        if (!sidebar.contains(e.target) && !toggle.contains(e.target) && sidebar.classList.contains("open")) {
          sidebar.classList.remove("open");
        }
      });
    }
  }

  function getCurrentUserId() {
    return (AppState.currentUser && AppState.currentUser.user_id) || "default";
  }

  function updateTopBarUser(user) {
    const topName = $("#topbar-user-name");
    const topAvatar = $("#topbar-user-avatar");
    const topEmail = $("#topbar-user-email");
    const logoutBtn = $("#logout-btn");

    if (user && user.user_id) {
      const displayName = user.full_name || (user.email ? user.email.split("@")[0] : "Student");
      if (topName) topName.textContent = displayName;
      if (topEmail) topEmail.textContent = user.email || "Learner";
      if (topAvatar) {
        if (user.picture_url) {
          topAvatar.innerHTML = `<img src="${esc(user.picture_url)}" alt="${esc(displayName)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
        } else {
          topAvatar.textContent = (displayName[0] || "S").toUpperCase();
        }
      }
      if (logoutBtn) logoutBtn.style.display = "inline-flex";
    } else {
      if (topName) topName.textContent = "Sign In";
      if (topEmail) topEmail.textContent = "Click to login";
      if (topAvatar) topAvatar.textContent = "?";
      if (logoutBtn) logoutBtn.style.display = "none";
    }
  }

  function showAuthModal(show = true) {
    const modal = $("#auth-modal");
    if (!modal) return;
    if (show) {
      if (typeof modal.showModal === "function") {
        if (!modal.open) modal.showModal();
      } else {
        modal.setAttribute("open", "");
      }
      initGoogleSignIn();
    } else {
      if (typeof modal.close === "function") {
        if (modal.open) modal.close();
      } else {
        modal.removeAttribute("open");
      }
    }
  }

  async function initGoogleSignIn() {
    let clientId = window.GOOGLE_CLIENT_ID || "";
    try {
      const cfg = await ApiService.getAuthConfig();
      if (cfg && cfg.google_client_id) {
        clientId = cfg.google_client_id;
      }
    } catch {}

    const tipContainer = $("#google-auth-tip");
    if (!clientId) {
      if (tipContainer) {
        tipContainer.innerHTML = `
          <div style="background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: var(--radius-md); padding: 0.65rem 0.85rem; font-size: 0.8rem; color: var(--ink-primary); text-align: left;">
            <div style="font-weight: 600; color: #b45309; margin-bottom: 0.2rem;">⚡ Google OAuth Key Not Configured</div>
            <div style="font-size: 0.76rem; color: var(--ink-muted); line-height: 1.35;">
              <code>GOOGLE_CLIENT_ID</code> is empty in <code>backend/.env</code>. For immediate local testing, click <strong>Ada Lovelace</strong> or <strong>Alan Turing</strong> below. To sign in with your real Google account, add your OAuth Web Client ID to <code>backend/.env</code>.
            </div>
          </div>
        `;
        tipContainer.style.display = "block";
      }
    } else {
      if (tipContainer) tipContainer.style.display = "none";
    }

    if (clientId && typeof window !== "undefined" && window.google && window.google.accounts) {
      try {
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async (response) => {
            if (response && response.credential) {
              await handleAuthSuccess(response.credential);
            }
          }
        });
        const container = document.getElementById("g_id_signin");
        if (container) {
          container.innerHTML = "";
          window.google.accounts.id.renderButton(container, {
            theme: "outline",
            size: "large",
            width: 320,
            shape: "rectangular"
          });
        }
      } catch (err) {
        console.warn("Google GIS init warning:", err);
      }
    } else if (!clientId) {
      const container = document.getElementById("g_id_signin");
      if (container) {
        container.innerHTML = `
          <button type="button" class="btn btn-outline" style="width: 100%; justify-content: center; gap: 0.65rem; padding: 0.65rem 1rem;" id="unconfigured-google-btn">
            <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>
            <span>Sign in with Google</span>
          </button>
        `;
        const unconfBtn = document.getElementById("unconfigured-google-btn");
        if (unconfBtn) {
          unconfBtn.onclick = () => {
            showToast("Google Client ID not yet set in backend/.env. Use Ada Lovelace or Alan Turing below to sign in instantly!", "warning");
          };
        }
      }
    }
  }

  async function handleAuthSuccess(credential) {
    try {
      const res = await ApiService.loginGoogle(credential);
      AppState.currentUser = res.user;
      AppState.studentName = res.user.full_name || res.user.email.split("@")[0];
      localStorage.setItem("cm_student_name", AppState.studentName);
      updateTopBarUser(AppState.currentUser);
      await checkAndRefreshMedicalStatus();
      showAuthModal(false);
      showToast(`Welcome back, ${AppState.studentName}!`, "success");
      await syncActiveDocument();
      navigateTo(AppState.currentRoute || "dashboard");
    } catch (err) {
      showToast(`Sign-in failed: ${err.message}`, "danger");
    }
  }

  function logoutStudent() {
    ApiService.logout();
    AppState.currentUser = null;
    AppState.studentName = "Guest Student";
    AppState.activeDoc = null;
    AppState.masteryList = [];
    AppState.graphData = null;
    const badge = $("#medical-student-badge");
    if (badge) badge.style.display = "none";
    updateTopBarUser(null);
    updateSidebarWidget({ ready: false, file: null });
    showToast("Signed out. Please sign in to resume studying.", "info");
    showAuthModal(true);
    navigateTo("dashboard");
  }

  function initAuth() {
    updateTopBarUser(AppState.currentUser);
    checkAndRefreshMedicalStatus();

    const logoutBtn = $("#logout-btn");
    if (logoutBtn) {
      logoutBtn.onclick = (e) => {
        e.stopPropagation();
        logoutStudent();
      };
    }

    const badge = $("#topbar-user-badge");
    if (badge) {
      badge.onclick = () => {
        if (!AppState.currentUser) {
          showAuthModal(true);
        }
      };
    }

    const devAdaBtn = $("#dev-login-ada");
    if (devAdaBtn) {
      devAdaBtn.onclick = () => {
        handleAuthSuccess("dev:google_ada_lovelace:ada.lovelace@university.edu:Ada Lovelace");
      };
    }

    const devAlanBtn = $("#dev-login-alan");
    if (devAlanBtn) {
      devAlanBtn.onclick = () => {
        handleAuthSuccess("dev:google_alan_turing:alan.turing@university.edu:Alan Turing");
      };
    }

    window.addEventListener("cm:unauthorized", () => {
      AppState.currentUser = null;
      updateTopBarUser(null);
      showAuthModal(true);
    });

    if (ApiService.isAuthenticated()) {
      ApiService.getCurrentUser().then(res => {
        if (res && res.user) {
          AppState.currentUser = res.user;
          AppState.studentName = res.user.full_name || res.user.email.split("@")[0];
          updateTopBarUser(AppState.currentUser);
        }
      }).catch(err => {
        console.warn("Session check error, logging out:", err);
        ApiService.clearAuth();
        AppState.currentUser = null;
        updateTopBarUser(null);
        showAuthModal(true);
      });
    } else {
      setTimeout(() => {
        if (!AppState.currentUser) {
          showAuthModal(true);
        }
      }, 500);
    }
  }

  // Global Document / Ingest Status Poller & Synchronizer
  async function syncActiveDocument() {
    try {
      const uid = getCurrentUserId();
      const matsData = await ApiService.listMaterials(uid).catch(() => ({ materials: [] }));
      const mats = matsData.materials || [];
      if (mats.length > 0) {
        const top = mats[0];
        const status = {
          ready: true,
          file: top.title || top.original_filename_or_url || "Active Study Material",
          pages: top.chunk_count || 1,
          concepts: top.concept_count || (top.concepts ? top.concepts.length : 0),
          user_id: uid
        };
        AppState.activeDoc = status;
        updateSidebarWidget(status);
      } else {
        AppState.activeDoc = { ready: false, file: null };
        updateSidebarWidget({ ready: false, file: null });
      }
    } catch (e) {
      console.warn("Could not sync active document status:", e);
      updateSidebarWidget({ ready: false, file: null });
    }
  }

  function updateSidebarWidget(doc) {
    const titleEl = $("#sidebar-doc-title");
    const metaEl = $("#sidebar-doc-meta");
    const pillEl = $("#sidebar-doc-pill");
    const topbarBadge = $("#topbar-doc-name");

    if (!titleEl || !metaEl || !pillEl || !topbarBadge) return;

    if (doc && doc.ready && doc.file) {
      titleEl.textContent = doc.file;
      metaEl.textContent = `${doc.pages || 1} page(s) · ${doc.concepts || 0} concepts`;
      pillEl.className = "status-pill strong";
      pillEl.textContent = "Ready";
      topbarBadge.textContent = doc.file;
    } else {
      titleEl.textContent = "No document active";
      metaEl.textContent = "Upload a study PDF";
      pillEl.className = "status-pill unknown";
      pillEl.textContent = "Offline";
      topbarBadge.textContent = "Upload PDF";
    }
  }

  // Source Citation Modal Logic
  function openSourceModal(citation) {
    const modal = $("#source-modal");
    if (!modal) return;
    const titleEl = $("#source-modal-title");
    const metaEl = $("#source-modal-meta");
    const textEl = $("#source-modal-text");

    titleEl.textContent = `Source Reference: ${citation.snippet || "Study Material"}`;
    metaEl.textContent = `Page ${citation.page || "1"} · Verified Grounded Chunk`;
    textEl.textContent = citation.text || `Citation reference on page ${citation.page}.`;

    if (typeof modal.showModal === "function") {
      modal.showModal();
    } else {
      modal.setAttribute("open", "");
    }
    renderMath(textEl);
  }

  // ── Medical ID Verification Frontend State & Modal Handlers ─────────
  let _pendingVerificationUpload = null;

  function isMedicalVerificationRequired(err) {
    if (!err) return false;
    if (err.status === 403) return true;
    if (err.code === "MEDICAL_VERIFICATION_REQUIRED") return true;
    if (err.detail && typeof err.detail === "object" && err.detail.code === "MEDICAL_VERIFICATION_REQUIRED") return true;
    const msg = String(err.message || "");
    return msg.includes("MEDICAL_VERIFICATION_REQUIRED") || msg.includes("verified medical student");
  }

  async function checkAndRefreshMedicalStatus(notify = false) {
    const badge = $("#medical-student-badge");
    const statusText = $("#med-verif-status-text");
    const retryBtn = $("#btn-retry-pending-upload");
    const uploadBtn = $("#btn-upload-med-id");
    const fileInput = $("#med-id-file-input");

    try {
      const res = await ApiService.getMedicalVerificationStatus();
      const isVerified = Boolean(res && (res.is_verified || res.status === "approved" || res.status === "verified"));
      if (badge) {
        badge.style.display = isVerified ? "inline-flex" : "none";
      }
      if (statusText) {
        statusText.textContent = res ? res.status : "Unverified";
        statusText.style.color = isVerified ? "#16a34a" : "#dc2626";
      }
      if (isVerified) {
        if (_pendingVerificationUpload && retryBtn) {
          retryBtn.style.display = "flex";
          if (uploadBtn) uploadBtn.style.display = "none";
          if (fileInput) fileInput.style.display = "none";
        }
        if (notify) showToast("✓ Verified Medical Student status confirmed!", "success");
      } else {
        if (retryBtn) retryBtn.style.display = "none";
        if (uploadBtn) uploadBtn.style.display = "flex";
        if (fileInput) fileInput.style.display = "none";
        if (notify) showToast(`Verification status: ${res ? res.status : "pending"}`, "info");
      }
      return isVerified;
    } catch (e) {
      if (badge) badge.style.display = "none";
      return false;
    }
  }

  async function openMedicalVerificationModal(err = null) {
    const modal = $("#medical-verification-modal");
    if (!modal) return;
    await checkAndRefreshMedicalStatus();
    if (typeof modal.showModal === "function") {
      if (!modal.open) modal.showModal();
    } else {
      modal.setAttribute("open", "");
    }
  }

  function initMedicalVerificationModal() {
    const modal = $("#medical-verification-modal");
    const closeBtn = $("#medical-verification-modal-close");
    const uploadBtn = $("#btn-upload-med-id");
    const fileInput = $("#med-id-file-input");
    const checkStatusBtn = $("#btn-check-med-status");
    const retryBtn = $("#btn-retry-pending-upload");

    if (closeBtn && modal) {
      closeBtn.onclick = () => {
        if (typeof modal.close === "function") modal.close();
        else modal.removeAttribute("open");
      };
    }

    if (checkStatusBtn) {
      checkStatusBtn.onclick = async () => {
        checkStatusBtn.disabled = true;
        checkStatusBtn.textContent = "Checking...";
        await checkAndRefreshMedicalStatus(true);
        checkStatusBtn.disabled = false;
        checkStatusBtn.textContent = "🔄 Refresh Status";
      };
    }

    if (uploadBtn && fileInput) {
      uploadBtn.onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        uploadBtn.disabled = true;
        uploadBtn.innerHTML = '<span>⏳ Verifying ID card...</span>';
        try {
          const formData = new FormData();
          formData.append("file", file);
          const res = await ApiService.verifyMedicalId(formData);
          if (res.is_medical_verified || res.verification_status === "approved") {
            showToast(res.message || "ID card verified! You now have clinical access.", "success");
            await checkAndRefreshMedicalStatus();
          } else {
            showToast(res.message || "ID card could not be verified as medical/bio student.", "danger");
          }
        } catch (e) {
          showToast(`Verification failed: ${e.message || "Unknown error"}`, "danger");
        } finally {
          uploadBtn.disabled = false;
          uploadBtn.innerHTML = '<span>📤 Upload Student ID Card</span>';
          fileInput.value = "";
        }
      };
    }

    if (retryBtn) {
      retryBtn.onclick = async () => {
        if (!_pendingVerificationUpload) return;
        retryBtn.disabled = true;
        retryBtn.textContent = "Retrying Ingestion...";
        try {
          if (_pendingVerificationUpload.type === "file") {
            await ApiService.ingestMaterialFile(_pendingVerificationUpload.files, getCurrentUserId());
            showToast("Material ingested successfully with verified medical access!", "success");
          } else if (_pendingVerificationUpload.type === "url") {
            const { url, sourceType, customTitle } = _pendingVerificationUpload;
            await ApiService.ingestMaterialUrl(url, sourceType, getCurrentUserId(), customTitle);
            showToast("URL material ingested successfully with verified medical access!", "success");
          }
          _pendingVerificationUpload = null;
          if (modal) {
            if (typeof modal.close === "function") modal.close();
            else modal.removeAttribute("open");
          }
          await syncActiveDocument();
          navigateTo("upload");
        } catch (err) {
          showToast(`Retry failed: ${err.message}`, "danger");
        } finally {
          retryBtn.disabled = false;
          retryBtn.textContent = "✓ Resume Uploading Study Material";
        }
      };
    }
  }

  function initModals() {
    initMedicalVerificationModal();
    const sourceClose = $("#source-modal-close");
    const sourceModal = $("#source-modal");
    if (sourceClose && sourceModal) {
      sourceClose.onclick = () => sourceModal.close();
      sourceModal.addEventListener("click", e => {
        if (e.target === sourceModal) sourceModal.close();
      });
    }

    const conceptClose = $("#concept-modal-close");
    const conceptModal = $("#concept-modal");
    if (conceptClose && conceptModal) {
      conceptClose.onclick = () => conceptModal.close();
      conceptModal.addEventListener("click", e => {
        if (e.target === conceptModal) conceptModal.close();
      });
    }

    const diagClose = $("#diagnostic-modal-close");
    const diagModal = $("#diagnostic-modal");
    if (diagClose && diagModal) {
      diagClose.onclick = () => diagModal.close();
      diagModal.addEventListener("click", e => {
        if (e.target === diagModal) diagModal.close();
      });
    }

    const delibClose = $("#modal-teacher-deliberation-close");
    const delibModal = $("#modal-teacher-deliberation");
    if (delibClose && delibModal) {
      delibClose.onclick = () => delibModal.close();
      delibModal.addEventListener("click", e => {
        if (e.target === delibModal) delibModal.close();
      });
    }
  }

  // -------------------------------------------------------------------------
  // Baseline Knowledge Diagnostic Engine
  // -------------------------------------------------------------------------
  async function startBaselineDiagnostic() {
    const modal = $("#diagnostic-modal");
    const body = $("#diagnostic-modal-body");
    if (!modal || !body) return;

    if (typeof modal.showModal === "function") {
      modal.showModal();
    } else {
      modal.setAttribute("open", "");
    }

    body.innerHTML = `
      <div style="padding: 2.5rem; text-align: center;">
        <div class="upload-icon-pulse" style="width: 44px; height: 44px; margin: 0 auto 1rem auto;">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <h4 style="margin-bottom: 0.5rem;">Generating Baseline Diagnostic...</h4>
        <p style="color: var(--ink-secondary); font-size: 0.88rem;">Selecting 6 representative assessment items across the prerequisite graph...</p>
      </div>
    `;

    try {
      const res = await ApiService.startDiagnostic(getCurrentUserId());
      const questions = (res && res.questions && res.questions.length) ? res.questions : [];
      if (!questions.length) {
        throw new Error("No diagnostic questions could be generated. Ensure study materials are uploaded.");
      }

      let currentIndex = 0;
      const userAnswers = [];
      const letters = ["A", "B", "C", "D"];

      function renderDiagQ() {
        const q = questions[currentIndex];
        const progressPct = Math.round((currentIndex / questions.length) * 100);
        const qType = (q.question_type || q.questionType || (q.options && q.options.length ? "mcq" : "typed_qa")).toLowerCase();

        let inputHtml = "";
        if (qType === "fill_in_the_blanks") {
          inputHtml = `
            <div style="margin: 1.25rem 0;">
              <input type="text" id="diag-user-input" class="fitb-blank-input" placeholder="Type missing keyword..." style="width: 100%; max-width: 340px;" autocomplete="off" />
            </div>
          `;
        } else if (qType === "typed_qa") {
          inputHtml = `
            <div style="margin: 1.25rem 0;">
              <textarea id="diag-user-input" class="quiz-textarea" rows="3" placeholder="Explain the concept in your own words..."></textarea>
            </div>
          `;
        } else if (qType === "numerical") {
          const params = q.given_parameters || q.givenParameters || {};
          inputHtml = `
            <div style="margin: 1.25rem 0;">
              ${Object.keys(params).length ? `
                <div class="numerical-params-grid" style="margin-bottom:0.75rem;">
                  ${Object.entries(params).map(([k, v]) => `
                    <div class="numerical-param-pill"><span class="param-key">${esc(k)}</span><span class="param-val">${esc(v)}</span></div>
                  `).join("")}
                </div>
              ` : ''}
              <input type="number" step="any" id="diag-user-input" class="numerical-input" placeholder="0.00" autocomplete="off" />
            </div>
          `;
        } else {
          // MCQ
          const opts = q.options || [];
          inputHtml = `
            <div class="quiz-options-group" style="margin: 1.25rem 0;" id="diag-options-group">
              ${opts.map((opt, i) => `
                <button type="button" class="quiz-opt-btn diag-opt-btn" data-index="${i}">
                  <span class="opt-letter-badge">${letters[i] || (i + 1)}</span>
                  <span class="opt-text">${esc(opt)}</span>
                </button>
              `).join("")}
            </div>
          `;
        }

        body.innerHTML = `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
            <span class="status-pill unknown">${esc(q.conceptName || q.concept_id || q.conceptId || "Concept")}</span>
            <div style="display:flex; align-items:center; gap:0.6rem;">
              <span style="font-size:0.82rem; font-weight:600; color:var(--ink-muted);">Question ${currentIndex + 1} of ${questions.length}</span>
              <div style="width:90px;" class="progress-bar-track">
                <div class="progress-bar-fill" style="width:${progressPct}%;"></div>
              </div>
            </div>
          </div>

          <h3 style="font-size:1.1rem; line-height:1.5; margin-bottom:1rem;">${esc(q.question_text || q.question)}</h3>

          ${inputHtml}

          <div style="display:flex; justify-content:flex-end; margin-top:1.5rem;">
            <button id="btn-diag-next" class="btn btn-primary" disabled>
              ${currentIndex === questions.length - 1 ? 'Finish Diagnostic &rarr;' : 'Next Question &rarr;'}
            </button>
          </div>
        `;
        renderMath(body);

        const nextBtn = $("#btn-diag-next", body);
        let selectedIdx = null;

        if (qType === "mcq") {
          const optBtns = body.querySelectorAll(".diag-opt-btn");
          optBtns.forEach(b => {
            b.onclick = () => {
              optBtns.forEach(btn => btn.classList.remove("selected"));
              b.classList.add("selected");
              selectedIdx = parseInt(b.getAttribute("data-index"), 10);
              nextBtn.disabled = false;
            };
          });
        } else {
          const textInput = $("#diag-user-input", body);
          if (textInput) {
            textInput.focus();
            textInput.addEventListener("input", () => {
              nextBtn.disabled = !textInput.value.trim();
            });
            textInput.addEventListener("keydown", e => {
              if (e.key === "Enter" && !nextBtn.disabled) nextBtn.click();
            });
          }
        }

        nextBtn.onclick = async () => {
          let typedVal = "";
          let numVal = null;
          if (qType === "mcq") {
            typedVal = letters[selectedIdx] || "";
          } else if (qType === "numerical") {
            const el = $("#diag-user-input", body);
            typedVal = el ? el.value.trim() : "";
            numVal = parseFloat(typedVal);
          } else {
            const el = $("#diag-user-input", body);
            typedVal = el ? el.value.trim() : "";
          }

          userAnswers.push({
            question_id: q.question_id || q.id,
            concept_id: q.concept_id || q.conceptId,
            selected_option_idx: selectedIdx,
            typed_answer: typedVal,
            student_reasoning: typedVal,
            numeric_answer: numVal
          });

          currentIndex++;
          if (currentIndex < questions.length) {
            renderDiagQ();
          } else {
            // Submit entire diagnostic
            body.innerHTML = `
              <div style="padding: 2.5rem; text-align: center;">
                <div class="upload-icon-pulse" style="width: 44px; height: 44px; margin: 0 auto 1rem auto;">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </div>
                <h4>Scoring Baseline Knowledge Profile...</h4>
                <p style="color: var(--ink-secondary); font-size: 0.88rem;">Conducting Multi-Agent Pedagogical Deliberation and unlocking prerequisite DAG...</p>
              </div>
            `;
            try {
              const subRes = await ApiService.submitDiagnostic(userAnswers, getCurrentUserId());
              const scorePct = subRes.score !== undefined ? subRes.score : 50;
              const correctCnt = subRes.correct_count !== undefined ? subRes.correct_count : 0;
              AppState.baselineCompleted = true;
              localStorage.setItem(`cm_baseline_${getCurrentUserId()}`, "true");

              body.innerHTML = `
                <div style="padding: 2rem; text-align: center;">
                  <div class="donut-chart-container" style="margin: 0 auto 1.25rem auto;">
                    ${createDonutSvg(scorePct, 120, 10, scorePct >= 65 ? "var(--color-strong)" : "var(--primary)")}
                    <div class="donut-chart-value">
                      <span class="val-number">${scorePct}%</span>
                      <span class="val-label">Baseline</span>
                    </div>
                  </div>
                  <h3 style="margin-bottom: 0.4rem;">Baseline Diagnostic Completed!</h3>
                  <p style="color: var(--ink-secondary); margin-bottom: 1.5rem; font-size: 0.9rem;">
                    You demonstrated familiarity with <strong>${correctCnt} of ${questions.length}</strong> core concepts. Your personalized prerequisite roadmap has been generated.
                  </p>
                  <div style="display:flex; justify-content:center; gap:0.75rem;">
                    <button id="btn-diag-done" class="btn btn-primary">Start Active Learning &rarr;</button>
                  </div>
                </div>
              `;
              const doneBtn = $("#btn-diag-done", body);
              if (doneBtn) {
                doneBtn.onclick = () => {
                  modal.close();
                  showToast("Baseline complete! Learning path unlocked.", "success");
                  navigateTo("dashboard");
                };
              }
            } catch (submitErr) {
              AppState.baselineCompleted = true;
              localStorage.setItem(`cm_baseline_${getCurrentUserId()}`, "true");
              body.innerHTML = `
                <div style="padding: 2rem; text-align: center;">
                  <h3>Baseline Complete</h3>
                  <p style="color: var(--ink-secondary); margin-bottom: 1rem;">${esc(submitErr.message || "Learning path unlocked.")}</p>
                  <button id="btn-diag-done" class="btn btn-primary">Return to Dashboard</button>
                </div>
              `;
              const doneBtn = $("#btn-diag-done", body);
              if (doneBtn) {
                doneBtn.onclick = () => {
                  modal.close();
                  navigateTo("dashboard");
                };
              }
            }
          }
        };
      }

      renderDiagQ();
    } catch (err) {
      body.innerHTML = `
        <div style="padding: 2rem; text-align: center;">
          <h4 style="color: var(--color-danger); margin-bottom: 0.5rem;">Diagnostic Error</h4>
          <p style="color: var(--ink-secondary); margin-bottom: 1.25rem;">${esc(err.message)}</p>
          <button class="btn btn-secondary" onclick="document.querySelector('#diagnostic-modal').close()">Close</button>
        </div>
      `;
    }
  }

  // -------------------------------------------------------------------------
  // Active Recall Stage Content Renderer
  // -------------------------------------------------------------------------
  function renderRecallStageContent(session, statusPill) {
    let card = session.card;
    if (!card) {
      const cObj = (AppState.masteryList || []).find(c => c.id === session.conceptId) || { name: session.conceptId, id: session.conceptId };
      const cName = (cObj && cObj.name) || session.conceptId || "Key Concept";
      card = {
        concept_id: session.conceptId || "concept",
        concept_name: cName,
        core_intuition: `${cName} is a foundational concept in your curriculum governing parameter optimization, model behavior, and system guarantees.`,
        formula_or_mechanism: `$$\\Delta \\theta = -\\eta \\nabla L(\\theta)$$ — parameter update rule along the direction of steepest error descent.`,
        key_formula_or_mechanism: `$$\\Delta \\theta = -\\eta \\nabla L(\\theta)$$ — parameter update rule along the direction of steepest error descent.`,
        worked_example: `Example: In a cycle with state $\\theta_0 = 1.50$, learning rate $\\eta = 0.05$, and gradient $\\nabla L = 2.00$, the updated state is $\\theta_1 = 1.50 - (0.05 \\times 2.00) = 1.40$.`,
        worked_mini_example: `Example: In a cycle with state $\\theta_0 = 1.50$, learning rate $\\eta = 0.05$, and gradient $\\nabla L = 2.00$, the updated state is $\\theta_1 = 1.50 - (0.05 \\times 2.00) = 1.40$.`,
        keywords: [cName, "Mechanism", "Parameter", "Optimization", "Gradient"],
        essential_keywords: [cName, "Mechanism", "Parameter", "Optimization", "Gradient"],
        source_citation: "Verified Course Materials · Section / Page 1",
        exact_source_citation: "Verified Course Materials · Section / Page 1",
        verification_question: `In your own words, what is the core role and function of ${cName}?`
      };
      session.card = card;
    }

    const formulaMech = card.formula_or_mechanism || card.key_formula_or_mechanism || "";
    const workedEx = card.worked_example || card.worked_mini_example || "";
    const keywordsList = card.keywords || card.essential_keywords || [];
    const sourceCite = card.source_citation || card.exact_source_citation || "Course Document";
    const verifQ = (typeof card.verification_question === 'object' && card.verification_question)
      ? (card.verification_question.question || card.verification_question.question_text || JSON.stringify(card.verification_question))
      : (card.verification_question || `How does ${card.concept_name || session.conceptId} operate?`);

    if (session.stage === 1) {
      // Stage 1: Teach Phase
      return `
        <div class="study-card">
          <div class="study-card-header">
            <div>
              <div style="display:flex; align-items:center; gap:0.6rem; margin-bottom:0.35rem;">
                <span class="status-pill ${statusPill}">${statusPill.toUpperCase()}</span>
                <span class="study-citation-pill">📖 ${esc(sourceCite)}</span>
              </div>
              <h2 class="study-concept-title">${esc(card.concept_name || session.conceptId)}</h2>
            </div>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span style="font-size:0.82rem; font-weight:600; color:var(--ink-secondary);">Study Timer:</span>
              <div class="timer-select-group" id="timer-select-group">
                <button type="button" class="timer-pill-btn ${session.timerSec === 60 ? 'active' : ''}" data-seconds="60">1m</button>
                <button type="button" class="timer-pill-btn ${session.timerSec === 180 ? 'active' : ''}" data-seconds="180">3m</button>
                <button type="button" class="timer-pill-btn ${session.timerSec === 300 ? 'active' : ''}" data-seconds="300">5m</button>
              </div>
            </div>
          </div>

          <div class="study-section">
            <span class="study-section-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              Core Intuition
            </span>
            <div class="study-core-intuition">${esc(card.core_intuition || "")}</div>
          </div>

          <div class="study-section">
            <span class="study-section-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
              Formula / Mechanism
            </span>
            <div class="study-formula-box">${formulaMech}</div>
          </div>

          <div class="study-section">
            <span class="study-section-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
              Worked Example
            </span>
            <div class="study-worked-example">${workedEx}</div>
          </div>

          <div class="study-section">
            <span class="study-section-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              Essential Concept Keywords (3-5)
            </span>
            <div class="study-keywords-row">
              ${keywordsList.map(kw => `<span class="study-keyword-tag">${esc(kw)}</span>`).join("")}
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end; padding-top:1rem; border-top:1px solid var(--border-subtle);">
            <button id="btn-start-recall-timer" class="btn btn-primary btn-lg">
              Start Learning Timer (${Math.round(session.timerSec/60)}m) &rarr;
            </button>
          </div>
        </div>
      `;
    }

    if (session.stage === 2) {
      // Stage 2: Timed Study
      const mins = Math.floor(session.timeLeft / 60);
      const secs = session.timeLeft % 60;
      const timeStr = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      const circumference = 2 * Math.PI * 38;
      const progressRatio = session.timeLeft / session.timerSec;
      const offset = circumference * (1 - progressRatio);

      return `
        <!-- Timed Study Countdown Banner -->
        <div class="timed-study-banner">
          <div style="display:flex; align-items:center; gap:1.25rem;">
            <div class="timer-ring-container">
              <svg class="timer-ring-svg" viewBox="0 0 90 90">
                <circle class="timer-ring-bg" cx="45" cy="45" r="38"></circle>
                <circle class="timer-ring-progress" id="timer-ring-circle" cx="45" cy="45" r="38"
                  style="stroke-dasharray: ${circumference}; stroke-dashoffset: ${offset};"></circle>
              </svg>
              <div class="timer-digital-display" id="timer-countdown-text">${timeStr}</div>
            </div>
            <div>
              <span class="badge-question-type mcq" style="background:rgba(56,189,248,0.2); color:#38bdf8; border-color:rgba(56,189,248,0.3);">
                Stage 2: Timed Study
              </span>
              <h3 style="color:#ffffff; margin:0.35rem 0 0.25rem 0;">Absorb the Core Mechanism</h3>
              <p style="margin:0; font-size:0.85rem; color:#cbd5e1;">Study the card below. When time runs out, the material will be hidden for blind retrieval.</p>
            </div>
          </div>
          <button id="btn-ready-test-now" class="btn btn-primary" style="background:#38bdf8; color:#0f172a; border:none; font-weight:700;">
            I'm Ready — Test Me Now &rarr;
          </button>
        </div>

        <!-- Study Card Visible during Timed Study -->
        <div class="study-card" style="margin-top:1.5rem;">
          <div class="study-card-header">
            <div>
              <h2 class="study-concept-title">${esc(card.concept_name || session.conceptId)}</h2>
              <span class="study-citation-pill">📖 ${esc(sourceCite)}</span>
            </div>
          </div>
          <div class="study-section">
            <span class="study-section-title">Core Intuition</span>
            <div class="study-core-intuition">${esc(card.core_intuition || "")}</div>
          </div>
          <div class="study-section">
            <span class="study-section-title">Formula / Mechanism</span>
            <div class="study-formula-box">${formulaMech}</div>
          </div>
          <div class="study-section">
            <span class="study-section-title">Worked Example</span>
            <div class="study-worked-example">${workedEx}</div>
          </div>
          <div class="study-section">
            <span class="study-section-title">Essential Keywords</span>
            <div class="study-keywords-row">
              ${keywordsList.map(kw => `<span class="study-keyword-tag">${esc(kw)}</span>`).join("")}
            </div>
          </div>
        </div>
      `;
    }

    if (session.stage === 3) {
      // Stage 3: Blind Retrieval (DOM UNMOUNTED - Study card NOT in DOM!)
      return `
        <div class="blind-retrieval-container">
          <div>
            <span class="blind-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
              Blind Retrieval Mode · Study Card Hidden
            </span>
            <h2 style="font-size:1.45rem; margin:0.75rem 0 0.35rem 0;">What do you recall about "${esc(card.concept_name || session.conceptId)}"?</h2>
            <p style="color:var(--ink-secondary); font-size:0.92rem; margin:0; line-height:1.5;">
              Write everything you remember from memory without looking at notes. Explain the core intuition, mechanism/formula, and essential terminology.
            </p>
          </div>

          <div style="position:relative;">
            <textarea id="active-recall-text" class="recall-textarea" rows="7" placeholder="Explain the concept in your own words, including its mechanism, formula/rules, and key terms...">${esc(session.recallText || "")}</textarea>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.4rem; font-size:0.8rem; color:var(--ink-muted);">
              <span>AI Epistemic Judge evaluates terminology coverage &amp; conceptual depth</span>
              <span id="recall-stats-display">0 words · 0 characters</span>
            </div>
          </div>

          <div class="verification-q-box">
            <span class="verification-q-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
              Targeted Mechanism Verification Check
            </span>
            <p style="margin:0; font-size:0.92rem; font-weight:600; color:var(--ink-primary);">${esc(verifQ)}</p>
            <input type="text" id="verification-answer-input" class="verification-input" placeholder="Enter concise verification answer..." value="${esc(session.verificationAnswer || "")}" autocomplete="off" />
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.5rem;">
            <span style="font-size:0.82rem; color:var(--ink-muted);">Minimum 15 characters required to submit.</span>
            <button id="btn-submit-active-recall" class="btn btn-primary" disabled>
              Submit Active Recall &rarr;
            </button>
          </div>
        </div>
      `;
    }

    if (session.stage === 4) {
      // Stage 4: Gap Audit
      const ev = session.evaluation || { score: 75, retained_keywords: [], missed_keywords: [], feedback: "Recall audit evaluated.", updated_mastery: { status: "STRONG", score: 0.8 } };
      const score = ev.score !== undefined ? ev.score : (ev.retrieval_score !== undefined ? Math.round(ev.retrieval_score * 100) : 70);
      const retained = ev.retained_keywords || ev.retained_concepts || [];
      const missed = ev.missed_keywords || ev.missed_concepts || [];
      const isStrong = score >= 65;

      return `
        <div class="gap-audit-grid">
          <!-- Left: Score & Mastery Badge -->
          <div class="gap-score-card">
            <div class="donut-chart-container">
              ${createDonutSvg(score, 140, 11, isStrong ? "var(--color-strong)" : "var(--color-weak)")}
              <div class="donut-chart-value">
                <span class="val-number">${score}%</span>
                <span class="val-label">Retrieval</span>
              </div>
            </div>

            <div style="margin-top:0.5rem;">
              <span class="status-pill ${isStrong ? 'strong' : 'weak'}" style="font-size:0.85rem; padding:0.35rem 0.85rem;">
                ${isStrong ? 'Concept Retained' : 'Needs Review'}
              </span>
              <p style="margin:0.5rem 0 0 0; font-size:0.82rem; color:var(--ink-secondary);">
                Epistemic Belief: <strong>${Math.round(((ev.updated_mastery && ev.updated_mastery.score) || 0.7) * 100)}%</strong>
              </p>
            </div>

            <div style="display:flex; flex-direction:column; gap:0.5rem; width:100%; margin-top:1rem;">
              <button id="btn-recall-retry" class="btn btn-secondary" style="width:100%;">
                ↺ Retry This Concept
              </button>
              <button id="btn-recall-continue" class="btn btn-primary" style="width:100%;">
                Next Concept &rarr;
              </button>
              <a href="#practice" class="btn btn-outline btn-sm" data-target-concept="${esc(session.conceptId)}" style="width:100%; text-align:center;">
                Test in Concept Check
              </a>
            </div>
          </div>

          <!-- Right: Concept Gap Audit & Grounded Comparison -->
          <div class="gap-breakdown-card">
            <div>
              <h3 style="margin:0 0 0.35rem 0; font-size:1.25rem;">Epistemic Gap Audit</h3>
              <p style="margin:0; font-size:0.88rem; color:var(--ink-secondary); line-height:1.5;">${esc(ev.feedback || "")}</p>
            </div>

            <!-- Retained vs Missed Keywords -->
            <div>
              <span class="diff-col-title" style="color:var(--color-strong-text);">Retained Keywords (${retained.length}):</span>
              <div class="keyword-pill-group">
                ${retained.length ? retained.map(k => `<span class="keyword-pill retained">✓ ${esc(k)}</span>`).join("") : `<span style="font-size:0.82rem; color:var(--ink-muted);">None detected</span>`}
              </div>

              <span class="diff-col-title" style="color:var(--color-danger); margin-top:0.85rem; display:block;">Missed Knowledge Gaps (${missed.length}):</span>
              <div class="keyword-pill-group">
                ${missed.length ? missed.map(k => `<span class="keyword-pill missed">✗ ${esc(k)}</span>`).join("") : `<span style="font-size:0.82rem; color:var(--color-strong);">No critical gaps omitted!</span>`}
              </div>
            </div>

            <!-- Side-by-Side Comparison -->
            <div>
              <h4 style="font-size:0.95rem; margin-bottom:0.4rem;">Side-by-Side Memory Audit</h4>
              <div class="side-by-side-diff">
                <div class="diff-col user-col">
                  <div class="diff-col-title">Your Retrieval Response</div>
                  <p style="margin:0; font-size:0.88rem;">${esc(session.recallText || "(No response entered)")}</p>
                  ${session.verificationAnswer ? `<div style="margin-top:0.6rem; font-size:0.82rem; color:var(--ink-muted);">Verification Answer: <em>${esc(session.verificationAnswer)}</em></div>` : ''}
                </div>

                <div class="diff-col grounded-col">
                  <div class="diff-col-title">Grounded Textbook Reference</div>
                  <p style="margin:0 0 0.5rem 0; font-size:0.88rem;">${esc(card.core_intuition || "")}</p>
                  <div style="font-size:0.9rem; padding:0.4rem 0.6rem; background:rgba(255,255,255,0.7); border-radius:var(--radius-sm); margin-bottom:0.4rem;">
                    ${formulaMech}
                  </div>
                  <span class="study-citation-pill" style="background:#fff;">📖 ${esc(sourceCite)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    return `<p>Invalid active recall stage.</p>`;
  }

  // SVG Chart Builders
  function createDonutSvg(percent, size = 130, strokeWidth = 10, color = "var(--primary)") {
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    const offset = circumference - (clamped / 100) * circumference;

    return `
      <svg class="donut-chart-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle class="donut-chart-bg" cx="${size/2}" cy="${size/2}" r="${radius}" stroke-width="${strokeWidth}"/>
        <circle class="donut-chart-segment" cx="${size/2}" cy="${size/2}" r="${radius}" stroke="${color}"
          stroke-width="${strokeWidth}" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
      </svg>
    `;
  }

  function createRadarSvg(concepts, size = 360) {
    if (!concepts || concepts.length < 3) {
      // Fallback if fewer than 3 concepts
      return `<div style="padding:1.5rem; text-align:center; color:var(--ink-muted);">Upload material with 3+ concepts to render radar chart.</div>`;
    }

    const items = concepts.slice(0, 6);
    const n = items.length;
    const center = size / 2;
    const radius = 78;
    const angleStep = (2 * Math.PI) / n;

    // Build polygon points for target (1.0 = 100%) and student score
    const targetPoints = [];
    const scorePoints = [];
    const axes = [];
    const labels = [];

    const shortName = name => {
      if (name.includes("Loss")) return "Loss";
      if (name.includes("Gradient")) return "Gradient";
      if (name.includes("Learning")) return "Learn Rate";
      if (name.includes("Backprop")) return "Backprop";
      if (name.includes("Overfitting")) return "Overfitting";
      if (name.includes("Regular")) return "Regularization";
      return name.split(" ")[0];
    };

    items.forEach((c, i) => {
      const angle = i * angleStep - Math.PI / 2;
      const xMax = center + radius * Math.cos(angle);
      const yMax = center + radius * Math.sin(angle);
      targetPoints.push(`${xMax},${yMax}`);
      axes.push(`<line x1="${center}" y1="${center}" x2="${xMax}" y2="${yMax}" stroke="var(--border-subtle)" stroke-width="1.5" stroke-dasharray="3 3"/>`);

      const s = (c.attempts && c.attempts > 0) ? Math.max(0.1, Math.min(1.0, c.score || 0)) : 0.05;
      const xScore = center + (radius * s) * Math.cos(angle);
      const yScore = center + (radius * s) * Math.sin(angle);
      scorePoints.push(`${xScore},${yScore}`);

      // Label coordinate with generous padding
      const xLabel = center + (radius + 24) * Math.cos(angle);
      const yLabel = center + (radius + 18) * Math.sin(angle);
      const anchor = Math.abs(xLabel - center) < 20 ? "middle" : (xLabel > center ? "start" : "end");
      labels.push(`<text x="${xLabel}" y="${yLabel}" font-size="11" fill="var(--ink-secondary)" font-weight="600" text-anchor="${anchor}">${esc(shortName(c.name))}</text>`);
    });

    // Background concentric rings
    const rings = [0.25, 0.5, 0.75, 1.0].map(r => {
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = i * angleStep - Math.PI / 2;
        pts.push(`${center + (radius * r) * Math.cos(a)},${center + (radius * r) * Math.sin(a)}`);
      }
      return `<polygon points="${pts.join(" ")}" fill="none" stroke="var(--border-subtle)" stroke-width="1"/>`;
    }).join("");

    return `
      <svg class="radar-chart-svg" viewBox="0 0 ${size} ${size}">
        ${rings}
        ${axes.join("")}
        <polygon points="${targetPoints.join(" ")}" fill="rgba(37, 99, 235, 0.05)" stroke="var(--primary-border)" stroke-width="1.5" stroke-dasharray="4 4"/>
        <polygon points="${scorePoints.join(" ")}" fill="rgba(37, 99, 235, 0.25)" stroke="var(--primary)" stroke-width="2.5"/>
        ${scorePoints.map(pt => {
          const [px, py] = pt.split(",");
          return `<circle cx="${px}" cy="${py}" r="4" fill="var(--primary)" stroke="#fff" stroke-width="2"/>`;
        }).join("")}
        ${labels.join("")}
      </svg>
    `;
  }

  // =========================================================================
  // VIEW RENDERERS
  // =========================================================================

  const Views = {
    // -----------------------------------------------------------------------
    // A. DASHBOARD VIEW
    // -----------------------------------------------------------------------
    async dashboard() {
      await syncActiveDocument();
      let masteryData = [];
      let recData = { actions: [] };
      let loopStatus = { loop_state: "UNINITIALIZED", material_ready: false, baseline_completed: false };

      try {
        const [mRes, rRes, lRes] = await Promise.all([
          ApiService.getMastery().catch(() => ({ concepts: [] })),
          ApiService.getRecommendations().catch(() => ({ actions: [] })),
          ApiService.getLoopStatus(getCurrentUserId()).catch(() => null)
        ]);
        masteryData = mRes.concepts || [];
        recData = rRes || { actions: [] };
        AppState.masteryList = masteryData;
        AppState.recommendations = recData.actions || [];
        if (lRes) {
          loopStatus = lRes;
          AppState.loopStatus = lRes;
          AppState.baselineCompleted = Boolean(lRes.baseline_completed);
        } else {
          const totalAttempts = masteryData.reduce((acc, c) => acc + (c.attempts || 0), 0);
          const localDone = (localStorage.getItem(`cm_baseline_${getCurrentUserId()}`) === "true");
          const isDone = localDone || totalAttempts >= 3;
          AppState.baselineCompleted = isDone;
          loopStatus = {
            loop_state: isDone ? "ACTIVE_LOOP" : (masteryData.length ? "BASELINE_DIAGNOSTIC" : "UNINITIALIZED"),
            material_ready: masteryData.length > 0,
            baseline_completed: isDone
          };
        }
      } catch (err) {
        console.warn("Failed fetching dashboard data", err);
      }

      const totalConcepts = masteryData.length;
      const strongCount = masteryData.filter(c => getConceptStatus(c) === "strong").length;
      const weakCount = masteryData.filter(c => getConceptStatus(c) === "weak").length;
      const unknownCount = masteryData.filter(c => getConceptStatus(c) === "unknown").length;

      const avgScore = totalConcepts > 0
        ? Math.round((masteryData.reduce((acc, c) => acc + (c.attempts > 0 ? (c.score || 0) : 0), 0) / totalConcepts) * 100)
        : 0;

      const topRec = recData.actions && recData.actions.length > 0 ? recData.actions[0] : null;

      // ── Empty-State Gating: No study materials uploaded ──────────────────
      if (totalConcepts === 0) {
        return `
          <div class="page-header">
            <div class="page-header-text">
              <h1>Welcome back, ${esc(AppState.studentName)}! 👋</h1>
              <p>Your closed-loop epistemic learning platform.</p>
            </div>
            <div class="page-header-actions">
              <button class="btn btn-secondary btn-disabled-gated" disabled title="Upload study material first to unlock quizzes">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Start Quick Quiz
              </button>
            </div>
          </div>

          <div class="empty-state-card">
            <div class="empty-state-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
                <path d="M12 12v9"/>
                <path d="m16 16-4-4-4 4"/>
              </svg>
            </div>
            <h3 class="empty-state-title">No Study Material Uploaded Yet</h3>
            <p class="empty-state-desc">
              No study material uploaded yet. Upload a PDF, lecture slides, YouTube link, or notes in the Study Material tab to generate your custom learning path.
            </p>
            <a href="#upload" class="btn btn-primary" style="margin-top:0.5rem;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Upload Study Material &rarr;
            </a>
          </div>
        `;
      }

      // ── Baseline Diagnostic Gating Check ─────────────────────────────────
      const isBaselineDiagnosticActive = (loopStatus.loop_state === "BASELINE_DIAGNOSTIC" || !loopStatus.baseline_completed);

      return `
        <div class="page-header">
          <div class="page-header-text">
            <h1>Welcome back, ${esc(AppState.studentName)}! 👋</h1>
            <p>Let's continue your closed-loop learning journey.</p>
          </div>
          <div class="page-header-actions">
            ${isBaselineDiagnosticActive ? `
              <button class="btn btn-secondary btn-disabled-gated" disabled title="Complete your Step 1 Baseline Diagnostic first">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Start Quick Quiz (Complete Baseline First)
              </button>
            ` : `
              <a href="#practice" class="btn btn-primary">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                Start Quick Quiz
              </a>
            `}
          </div>
        </div>

        ${isBaselineDiagnosticActive ? `
          <!-- Step 1: First-Run Baseline Diagnostic CTA Banner -->
          <div class="diagnostic-cta-banner" id="baseline-diagnostic-banner">
            <div>
              <div class="diagnostic-badge-pill">Step 1 · Initial Knowledge Mapping</div>
              <h2 class="diagnostic-title">Take Your Baseline Diagnostic Quiz</h2>
              <p class="diagnostic-desc">
                Answer 6 quick diagnostic questions to baseline what you already know and unlock your active learning path.
              </p>
            </div>
            <button id="btn-start-baseline-diagnostic" class="btn btn-primary" style="background:#ffffff; color:#1e3a8a; border:none; font-weight:700;">
              Start Baseline Diagnostic &rarr;
            </button>
          </div>
        ` : ''}

        <!-- Hero Section Grid -->
        <div class="grid grid-dashboard-hero">
          <!-- Card 1: Visual Learning Progress -->
          <div class="card progress-hero-card">
            <h3 style="margin-bottom: 1.25rem; font-size: 1.15rem;">Your Learning Progress</h3>
            <div class="hero-content-split">
              <div class="donut-chart-container">
                ${createDonutSvg(avgScore, 130, 11, "#3b82f6")}
                <div class="donut-chart-value">
                  <span class="val-number" style="color:#ffffff;">${avgScore}%</span>
                  <span class="val-label" style="color:#cbd5e1;">Mastery</span>
                </div>
              </div>

              <div class="hero-stats-breakdown">
                <div class="hero-metric-legend">
                  <div class="metric-legend-item">
                    <div class="metric-legend-tag">
                      <span class="legend-dot strong"></span>
                      <span>Strong Concepts</span>
                    </div>
                    <span class="metric-legend-num">${strongCount} (${totalConcepts ? Math.round((strongCount/totalConcepts)*100) : 0}%)</span>
                  </div>
                  <div class="metric-legend-item">
                    <div class="metric-legend-tag">
                      <span class="legend-dot weak"></span>
                      <span>Weak Concepts</span>
                    </div>
                    <span class="metric-legend-num">${weakCount} (${totalConcepts ? Math.round((weakCount/totalConcepts)*100) : 0}%)</span>
                  </div>
                  <div class="metric-legend-item">
                    <div class="metric-legend-tag">
                      <span class="legend-dot unknown"></span>
                      <span>Unknown Concepts</span>
                    </div>
                    <span class="metric-legend-num">${unknownCount} (${totalConcepts ? Math.round((unknownCount/totalConcepts)*100) : 0}%)</span>
                  </div>
                </div>

                <div style="margin-top:0.5rem;">
                  <a href="#learning-path" class="btn btn-secondary btn-sm" style="background:rgba(255,255,255,0.15); color:#fff; border-color:rgba(255,255,255,0.25);">
                    Continue Learning &rarr;
                  </a>
                </div>
              </div>
            </div>
          </div>

          <!-- Card 2: Proactive Recommendation -->
          <div class="card recommendation-card">
            <div>
              <div class="rec-header-badge">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
                <span>Next Recommendation</span>
              </div>
              <h3 class="rec-concept-name">
                ${topRec ? esc(topRec.type) + ": " + esc(topRec.name) : "Ready to Learn"}
              </h3>
              <div class="rec-reason-box">
                ${topRec ? esc(topRec.reason) : "Upload study material to generate personalized concept recommendations."}
              </div>
            </div>

            <div style="display:flex; gap:0.65rem;">
              ${topRec ? `
                <a href="#practice" data-target-concept="${esc(topRec.conceptId)}" class="btn btn-primary start-target-quiz start-remedial-review">
                  Start Review &rarr;
                </a>
                <a href="#tutor" class="btn btn-secondary">
                  Ask Tutor
                </a>
              ` : `
                <a href="#upload" class="btn btn-primary">
                  Upload PDF &rarr;
                </a>
              `}
            </div>
          </div>
        </div>

        <!-- Learning Journey Workflow Stepper -->
        <div class="card journey-card">
          <div class="card-header">
            <h3 class="card-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              Your Learning Journey
            </h3>
            <a href="#learning-path" class="btn btn-outline btn-sm">View Full Path &rarr;</a>
          </div>

          <div class="journey-pipeline">
            <div class="journey-step ${AppState.activeDoc && AppState.activeDoc.ready ? 'completed' : 'active'}" data-nav="upload">
              <div class="step-circle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              </div>
              <span class="step-label">1. Upload<br>Material</span>
            </div>

            <div class="journey-step ${totalConcepts > 0 ? 'completed' : ''}" data-nav="learning-path">
              <div class="step-circle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
              </div>
              <span class="step-label">2. Learn<br>Concepts</span>
            </div>

            <div class="journey-step ${!isBaselineDiagnosticActive ? 'completed' : 'active'}" data-nav="practice">
              <div class="step-circle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
              </div>
              <span class="step-label">3. Take<br>Quiz</span>
            </div>

            <div class="journey-step ${weakCount > 0 ? 'active' : ''}" data-nav="progress">
              <div class="step-circle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
              </div>
              <span class="step-label">4. Review<br>Weak Topics</span>
            </div>

            <div class="journey-step ${strongCount >= totalConcepts && totalConcepts > 0 ? 'completed' : ''}" data-nav="progress">
              <div class="step-circle">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
              </div>
              <span class="step-label">5. Master<br>Concept</span>
            </div>
          </div>
        </div>

        <!-- Concept Progress Quick Glance -->
        <div class="card" style="margin-top: 1.5rem;">
          <div class="card-header">
            <h3 class="card-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
              Concept Mastery Status
            </h3>
            <a href="#progress" class="btn btn-outline btn-sm">Full Analytics &rarr;</a>
          </div>

          <div class="concept-preview-list">
            ${masteryData.slice(0, 5).map(c => {
              const badge = renderOutcomeBadge(c);
              return `
                <div class="concept-preview-item" style="display:flex; justify-content:space-between; align-items:center; padding:0.85rem 0; border-bottom:1px solid var(--border-subtle);">
                  <div class="concept-preview-left">
                    <span class="concept-preview-name" style="font-weight:600; font-size:0.95rem;">${esc(c.name)}</span>
                    <span class="concept-preview-stats" style="font-size:0.8rem; color:var(--ink-secondary); display:block; margin-top:0.2rem;">${c.attempts || 0} interaction(s) · Multi-Agent Pedagogical Assessment</span>
                  </div>
                  <div style="display:flex; align-items:center; gap:0.65rem;">
                    ${badge}
                    <button class="btn btn-outline btn-sm btn-inspect-deliberation" data-concept-id="${esc(c.id)}" data-concept-name="${esc(c.name)}" title="Inspect Multi-Agent Deliberation">
                      Inspect Deliberation
                    </button>
                    <a href="#practice" data-target-concept="${esc(c.id)}" class="btn btn-secondary btn-sm start-target-quiz">Quiz</a>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        </div>
      `;
    },

    // -----------------------------------------------------------------------
    // B. STUDY MATERIAL / UPLOAD VIEW
    // -----------------------------------------------------------------------
    async upload() {
      await syncActiveDocument();
      const doc = AppState.activeDoc;
      const matsData = await ApiService.listMaterials(getCurrentUserId()).catch(() => ({ materials: [] }));
      const materials = matsData.materials || [];

      return `
        <div class="page-header">
          <div class="page-header-text">
            <h1>Universal Study Material Hub</h1>
            <p>Ingest textbooks (PDF), slide decks (PPTX), markdown notes (MD/DOCX), YouTube video lectures, web articles (GeeksforGeeks), or student voice notes into the vectorless BM25 index.</p>
          </div>
          <div class="page-header-actions">
            <button id="btn-load-sample" class="btn btn-secondary">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              Try Sample: ML Basics
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2">
          <!-- Add Study Material Multi-Source Card -->
          <div class="card">
            <!-- Tabs Navigation -->
            <div class="upload-tabs-nav">
              <button class="upload-tab-btn active" data-tab="file">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                File Upload
              </button>
              <button class="upload-tab-btn" data-tab="url">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                YouTube / Web URL
              </button>
              <button class="upload-tab-btn" data-tab="voice">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
                Voice Note
              </button>
            </div>

            <!-- Tab 1: File Upload -->
            <div class="upload-tab-content active" id="tab-content-file">
              <div class="upload-dropzone" id="upload-dropzone">
                <input type="file" id="material-file-input" accept=".pdf,.pptx,.ppt,.md,.txt,.docx,.mp3,.wav,.m4a,.webm" multiple style="display:none;">
                <div class="upload-icon-pulse">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                  </svg>
                </div>
                <h4 style="font-size:1.05rem; margin-bottom:0.35rem;">Drag & drop study materials here</h4>
                <p style="font-size:0.82rem; color:var(--ink-muted);">Supports PDF, PPTX, Word (.docx), Markdown (.md), and Audio (.mp3, .wav, .m4a)</p>

                <div id="selected-file-display" style="display:none;" class="upload-file-details">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <span id="selected-file-name">filename</span>
                </div>
              </div>

              <div style="margin-top:1.25rem; display:flex; justify-content:flex-end;">
                <button class="btn btn-primary" id="btn-process-files" disabled>
                  Process Study Material(s)
                </button>
              </div>
            </div>

            <!-- Tab 2: YouTube / Web Article URL -->
            <div class="upload-tab-content" id="tab-content-url">
              <div style="display:flex; flex-direction:column; gap:1rem;">
                <div>
                  <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:0.4rem;">Source URL</label>
                  <input type="url" id="input-material-url" class="form-control" placeholder="https://www.youtube.com/watch?v=... or https://www.geeksforgeeks.org/..." style="width:100%; padding:0.65rem 0.85rem; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); font-size:0.9rem;">
                </div>

                <div class="grid grid-cols-2" style="gap:0.75rem;">
                  <div>
                    <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:0.4rem;">Source Type</label>
                    <select id="select-url-type" class="form-control" style="width:100%; padding:0.65rem; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); font-size:0.88rem;">
                      <option value="auto">Auto-Detect</option>
                      <option value="youtube">YouTube Video</option>
                      <option value="web">Educational Website / Article</option>
                    </select>
                  </div>
                  <div>
                    <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:0.4rem;">Custom Title (Optional)</label>
                    <input type="text" id="input-url-title" class="form-control" placeholder="e.g. Backpropagation Lecture" style="width:100%; padding:0.65rem 0.85rem; border:1px solid var(--border-subtle); border-radius:var(--radius-sm); font-size:0.88rem;">
                  </div>
                </div>

                <div style="display:flex; justify-content:flex-end; margin-top:0.5rem;">
                  <button class="btn btn-primary" id="btn-ingest-url">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                    Ingest URL Source
                  </button>
                </div>
              </div>
            </div>

            <!-- Tab 3: Record Voice Note -->
            <div class="upload-tab-content" id="tab-content-voice">
              <div class="voice-record-box">
                <button class="mic-pulse-btn" id="btn-record-mic" title="Click to start recording">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
                </button>
                <div class="voice-timer" id="voice-timer">00:00</div>
                <p id="voice-status-text" style="font-size:0.85rem; color:var(--ink-muted); margin-top:0.4rem;">Click microphone to record a spoken lecture note</p>
                <audio id="voice-preview-audio" controls style="display:none; width:100%; margin-top:1rem; border-radius:var(--radius-sm);"></audio>
              </div>

              <div style="margin-top:1.25rem; display:flex; justify-content:flex-end;">
                <button class="btn btn-primary" id="btn-ingest-voice" disabled>
                  Transcribe & Ingest Spoken Note
                </button>
              </div>
            </div>
          </div>

          <!-- Processing Stages & Status Card -->
          <div class="card">
            <h3 style="margin-bottom: 1.25rem;">LangGraph Ingestion Pipeline</h3>
            <div class="stages-list" id="ingest-stages">
              <div class="stage-item ${doc && doc.ready ? 'done' : ''}" id="stage-1">
                <div class="stage-status-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div class="stage-item-text">
                  <h4>1. Type Detector & Content Extractor</h4>
                  <p>Extracts pages, PPTX slides, YouTube transcripts, web articles, or audio speech.</p>
                </div>
              </div>

              <div class="stage-item ${doc && doc.ready ? 'done' : ''}" id="stage-2">
                <div class="stage-status-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div class="stage-item-text">
                  <h4>2. Semantic Section Chunker</h4>
                  <p>Segments content into ~110-word passages anchored with exact citations ([Slide X], [04:15], etc.).</p>
                </div>
              </div>

              <div class="stage-item ${doc && doc.ready ? 'done' : ''}" id="stage-3">
                <div class="stage-status-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div class="stage-item-text">
                  <h4>3. Synonym Normalizer & BM25 Inverted Index</h4>
                  <p>Populates vectorless SQLite tables (chunks, concept_chunks, chunk_fts) without dense embeddings.</p>
                </div>
              </div>

              <div class="stage-item ${doc && doc.ready ? 'done' : ''}" id="stage-4">
                <div class="stage-status-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div class="stage-item-text">
                  <h4>4. Unified Prerequisite Concept DAG</h4>
                  <p>Merges heterogeneous materials into a unified topological dependency graph.</p>
                </div>
              </div>
            </div>

            <!-- Active Material Summary -->
            <div style="margin-top:1.5rem; padding-top:1.25rem; border-top:1px solid var(--border-subtle);">
              <h4 style="margin-bottom:0.5rem; font-size:0.95rem;">Current Active Knowledge Base</h4>
              ${doc && doc.ready ? `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div>
                    <span style="font-weight:700; color:var(--ink-primary);">${esc(doc.file)}</span>
                    <p style="font-size:0.8rem; margin:0;">${doc.pages} page/segment(s) · ${doc.concepts} concepts indexed</p>
                  </div>
                  <span class="status-pill strong">Online</span>
                </div>
              ` : `
                <p style="color:var(--ink-muted); font-size:0.85rem;">No active study material loaded. Upload a file, paste a link, or load the sample above.</p>
              `}
            </div>
          </div>
        </div>

        <!-- My Study Materials Library Card -->
        <div class="card materials-library-section">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1.25rem;">
            <div>
              <h3 style="margin:0 0 0.25rem 0;">My Study Materials</h3>
              <p style="margin:0; font-size:0.85rem; color:var(--ink-muted);">Inspect exact parsed pages, slides, or timestamped transcripts stored in the vectorless database.</p>
            </div>
            <span class="active-doc-badge" style="font-weight:600;">
              ${materials.length} Ingested Material${materials.length === 1 ? '' : 's'}
            </span>
          </div>

          ${materials.length > 0 ? `
            <div class="materials-table-wrap">
              <table class="materials-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Material Title & Source</th>
                    <th>Extracted Chunks</th>
                    <th>Canonical Concepts</th>
                    <th>Added On</th>
                    <th style="text-align:right;">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${materials.map(m => {
                    const badgeClass = `badge-${(m.source_type || 'pdf').toLowerCase()}`;
                    return `
                      <tr>
                        <td>
                          <span class="material-type-badge ${badgeClass}">${esc(m.source_type)}</span>
                        </td>
                        <td>
                          <div style="font-weight:600; color:var(--ink-primary);">${esc(m.title)}</div>
                          <div style="font-size:0.78rem; color:var(--ink-muted); max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            ${esc(m.original_filename_or_url)}
                          </div>
                        </td>
                        <td>
                          <strong>${m.chunk_count}</strong> chunk(s)
                        </td>
                        <td>
                          <span style="font-size:0.85rem;">${m.concept_count} concept(s)</span>
                        </td>
                        <td style="font-size:0.82rem; color:var(--ink-muted);">
                          ${(m.created_at || '').slice(0, 10)}
                        </td>
                        <td style="text-align:right;">
                          <div class="material-actions" style="justify-content:flex-end;">
                            <button class="btn btn-sm btn-secondary btn-preview-mat" data-id="${esc(m.material_id)}">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
                              Preview
                            </button>
                            <button class="btn btn-sm btn-outline-danger btn-delete-mat" data-id="${esc(m.material_id)}" title="Delete material">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                            </button>
                          </div>
                        </td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <div style="text-align:center; padding:2.5rem 1rem; color:var(--ink-muted); background:var(--surface-muted); border-radius:var(--radius-md);">
              <p style="margin:0 0 0.5rem 0; font-size:1rem; font-weight:600; color:var(--ink-secondary);">No materials ingested yet.</p>
              <p style="margin:0; font-size:0.85rem;">Upload a PDF, presentation, doc, or YouTube link above to start building your personalized knowledge base.</p>
            </div>
          `}
        </div>
      `;
    },

    // -----------------------------------------------------------------------
    // C. AI TUTOR VIEW
    // -----------------------------------------------------------------------
    async tutor() {
      await syncActiveDocument();
      const doc = AppState.activeDoc;
      const docTitle = doc && doc.ready ? doc.file : "Calculus / ML Notes";

      return `
        <div class="page-header" style="margin-bottom:1.25rem;">
          <div class="page-header-text">
            <h1>AI Tutor</h1>
            <p>Ask anything about your study material. Answers are strictly grounded in your document with verifiable citations.</p>
          </div>
          <div class="page-header-actions">
            <span class="active-doc-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>
              <span>Using: <strong>${esc(docTitle)}</strong></span>
            </span>
          </div>
        </div>

        <div class="tutor-container">
          <div class="tutor-header-bar">
            <div style="display:flex; align-items:center; gap:0.65rem;">
              <div class="chat-avatar bot-avatar">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
              </div>
              <div>
                <span style="font-weight:700; font-size:0.92rem; color:var(--ink-primary);">Concept Mastery Tutor</span>
                <span style="display:block; font-size:0.75rem; color:var(--color-strong);">● Grounded RAG + TinyFish Web Search active</span>
              </div>
            </div>
            <button id="btn-clear-chat" class="btn btn-secondary btn-sm" title="Clear conversation history">
              Clear History
            </button>
          </div>

          <!-- Message Stream -->
          <div class="tutor-messages-stream" id="tutor-messages-stream">
            ${AppState.chatMessages.map(msg => renderChatMessage(msg)).join("")}
          </div>

          <!-- Suggested Action Chips -->
          <div class="tutor-suggestions" id="tutor-suggestions">
            <button class="suggestion-chip" data-prompt="Can you give me an example with math formulas?">Can you give me an example?</button>
            <button class="suggestion-chip" data-prompt="What are the essential prerequisites for this concept?">What are the prerequisites?</button>
            <button class="suggestion-chip" data-prompt="Search the web for recent industry applications of this concept.">Search web for applications</button>
            <button class="suggestion-chip" data-prompt="Explain this simply as if I were a beginner.">Explain simply</button>
          </div>

          <!-- Tutor Input Form -->
          <form class="tutor-input-form" id="tutor-input-form">
            <input type="text" id="tutor-question-input" placeholder="Ask about your study material, concepts, or search the web..." autocomplete="off" required>
            <button type="submit" class="btn btn-primary" id="btn-tutor-send">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              Send
            </button>
          </form>
        </div>
      `;
    },

    // -----------------------------------------------------------------------
    // ACTIVE RECALL INTERACTIVE ENGINE (4-STAGE EPISTEMIC CYCLE)
    // -----------------------------------------------------------------------
    async activeRecall() {
      await syncActiveDocument();
      if (!AppState.masteryList || !AppState.masteryList.length) {
        try {
          const mRes = await ApiService.getMastery();
          AppState.masteryList = mRes.concepts || [];
        } catch (e) {
          console.warn("Could not load mastery list for active recall", e);
        }
      }

      const concepts = AppState.masteryList || [];
      if (concepts.length === 0) {
        return `
          <div class="page-header">
            <div class="page-header-text">
              <h1>Active Recall</h1>
              <p>Epistemic retrieval practice: Study &rarr; Focus Under Timer &rarr; Blind Retrieval &rarr; Gap Audit.</p>
            </div>
          </div>
          <div class="empty-state-card">
            <div class="empty-state-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 4.44-2.04"/>
                <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-4.44-2.04"/>
              </svg>
            </div>
            <h3 class="empty-state-title">No Study Material Uploaded Yet</h3>
            <p class="empty-state-desc">
              Upload a PDF, lecture slides, YouTube link, or notes in the Study Material tab to generate your custom learning path and practice active recall.
            </p>
            <a href="#upload" class="btn btn-primary" style="margin-top:0.5rem;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Upload Study Material &rarr;
            </a>
          </div>
        `;
      }

      if (!AppState.activeRecallSession) {
        const weak = concepts.find(c => getConceptStatus(c) === "weak");
        const defaultCid = weak ? weak.id : concepts[0].id;
        AppState.activeRecallSession = {
          stage: 1,
          conceptId: defaultCid,
          timerSec: 180,
          timeLeft: 180,
          timerInterval: null,
          card: null,
          recallText: "",
          verificationAnswer: "",
          evaluation: null
        };
      }

      const session = AppState.activeRecallSession;
      if (!session.conceptId && concepts.length) {
        session.conceptId = concepts[0].id;
      }

      // Load card if needed
      if (!session.card || session.card.concept_id !== session.conceptId) {
        try {
          const cardRes = await ApiService.startActiveRecall(session.conceptId, getCurrentUserId());
          if (cardRes) {
            const rawCard = cardRes.card || cardRes;
            session.card = {
              ...rawCard,
              concept_id: rawCard.concept_id || session.conceptId,
              concept_name: rawCard.concept_name || session.conceptId,
              core_intuition: rawCard.core_intuition || "",
              formula_or_mechanism: rawCard.formula_or_mechanism || rawCard.key_formula_or_mechanism || "",
              key_formula_or_mechanism: rawCard.key_formula_or_mechanism || rawCard.formula_or_mechanism || "",
              worked_example: rawCard.worked_example || rawCard.worked_mini_example || "",
              worked_mini_example: rawCard.worked_mini_example || rawCard.worked_example || "",
              keywords: rawCard.keywords || rawCard.essential_keywords || [],
              essential_keywords: rawCard.essential_keywords || rawCard.keywords || [],
              source_citation: rawCard.source_citation || rawCard.exact_source_citation || "Course Document",
              exact_source_citation: rawCard.exact_source_citation || rawCard.source_citation || "Course Document",
              verification_question: rawCard.verification_question
            };
          }
        } catch (e) {
          console.warn("Could not load active recall card from backend, generating local card", e);
        }

        if (!session.card || session.card.concept_id !== session.conceptId) {
          const cObj = concepts.find(c => c.id === session.conceptId) || { name: session.conceptId, id: session.conceptId };
          const cName = cObj.name || session.conceptId;
          session.card = {
            concept_id: session.conceptId,
            concept_name: cName,
            core_intuition: `${cName} is a foundational principle in your curriculum governing parameter optimization, model behavior, and system guarantees.`,
            formula_or_mechanism: `$$\\Delta \\theta = -\\eta \\nabla L(\\theta)$$ — parameter update rule along the direction of steepest error descent.`,
            key_formula_or_mechanism: `$$\\Delta \\theta = -\\eta \\nabla L(\\theta)$$ — parameter update rule along the direction of steepest error descent.`,
            worked_example: `Example: In a cycle with state $\\theta_0 = 1.50$, learning rate $\\eta = 0.05$, and gradient $\\nabla L = 2.00$, the updated state is $\\theta_1 = 1.50 - (0.05 \\times 2.00) = 1.40$.`,
            worked_mini_example: `Example: In a cycle with state $\\theta_0 = 1.50$, learning rate $\\eta = 0.05$, and gradient $\\nabla L = 2.00$, the updated state is $\\theta_1 = 1.50 - (0.05 \\times 2.00) = 1.40$.`,
            keywords: [cName, "Mechanism", "Parameter", "Optimization", "Gradient"],
            essential_keywords: [cName, "Mechanism", "Parameter", "Optimization", "Gradient"],
            source_citation: "Verified Course Materials · Section / Page 1",
            exact_source_citation: "Verified Course Materials · Section / Page 1",
            verification_question: `In your own words, what is the core role and function of ${cName}?`
          };
        }
      }

      const activeConcept = concepts.find(c => c.id === session.conceptId) || { id: session.conceptId, name: session.conceptId };
      const statusPill = getConceptStatus(activeConcept);

      function cleanConceptLabel(c) {
        let name = c.name || c.id || "Concept";
        if (/^segment\s+\d/i.test(name) || /^video\s*\[/i.test(name)) {
          return `Topic: ${name.replace(/^Video\s*\[?/i, '').replace(/\]$/, '')}`;
        }
        return name;
      }

      const conceptSelectHtml = concepts.map(c => `
        <option value="${esc(c.id)}" ${c.id === session.conceptId ? "selected" : ""}>
          ${esc(cleanConceptLabel(c))} (${getConceptStatus(c)})
        </option>
      `).join("");

      return `
        <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:1rem;">
          <div class="page-header-text">
            <h1>Active Recall Interactive Engine</h1>
            <p>4-Stage Epistemic Cycle: Study &rarr; Focus Under Timer &rarr; Blind Retrieval &rarr; Gap Audit.</p>
          </div>
          <div class="page-header-actions" style="display:flex; align-items:center; gap:0.6rem;">
            <label for="recall-concept-select" style="font-size:0.85rem; font-weight:600; color:var(--ink-secondary);">Concept:</label>
            <select id="recall-concept-select" class="form-select" style="padding:0.45rem 0.85rem; border-radius:var(--radius-sm); border:1px solid var(--border-subtle); background:var(--surface); font-size:0.88rem; font-weight:600; color:var(--ink-primary); cursor:pointer;">
              ${conceptSelectHtml}
            </select>
          </div>
        </div>

        <div class="active-recall-container">
          <!-- 4-Stage Stepper -->
          <div class="recall-stage-stepper">
            <div class="recall-step-tab ${session.stage === 1 ? 'active' : (session.stage > 1 ? 'completed' : '')}">
              <div class="recall-step-num">1</div>
              <span>Teach Phase</span>
            </div>
            <div class="recall-step-tab ${session.stage === 2 ? 'active' : (session.stage > 2 ? 'completed' : '')}">
              <div class="recall-step-num">2</div>
              <span>Timed Study</span>
            </div>
            <div class="recall-step-tab ${session.stage === 3 ? 'active' : (session.stage > 3 ? 'completed' : '')}">
              <div class="recall-step-num">3</div>
              <span>Blind Retrieval</span>
            </div>
            <div class="recall-step-tab ${session.stage === 4 ? 'active' : ''}">
              <div class="recall-step-num">4</div>
              <span>Gap Audit</span>
            </div>
          </div>

          <!-- Dynamic Stage Content Area -->
          <div id="recall-stage-content">
            ${renderRecallStageContent(session, statusPill)}
          </div>
        </div>
      `;
    },

    // -----------------------------------------------------------------------
    // C2. SMART STUDY NOTES & MULTIMODAL ARTIFACTS
    // -----------------------------------------------------------------------
    async smartNotes() {
      await syncActiveDocument();
      const userId = getCurrentUserId();

      // Fetch concepts list from mastery or graph
      let conceptsList = [];
      try {
        const [mRes, gRes] = await Promise.all([
          ApiService.getMastery().catch(() => ({ concepts: [] })),
          ApiService.getConceptsGraph().catch(() => ({ nodes: [] }))
        ]);
        if (mRes && mRes.concepts && mRes.concepts.length) {
          conceptsList = mRes.concepts.map(c => ({
            id: c.id,
            label: c.name || c.id.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase()),
            score: c.score
          }));
        } else if (gRes && gRes.nodes && gRes.nodes.length) {
          conceptsList = gRes.nodes.map(n => ({
            id: n.id,
            label: n.label || n.id.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase())
          }));
        }
      } catch (e) {
        console.warn("Could not fetch concepts for smart notes", e);
      }

      if (!conceptsList.length) {
        return `
          <div class="page-header">
            <div class="page-header-text">
              <h1 class="page-title">Smart Study Notes</h1>
              <p class="page-subtitle">
                Elicit targeted study formats grounded in primary material chunks with ElevenLabs voice notes, PDF handouts, and PPTX slide decks.
              </p>
            </div>
          </div>
          <div class="empty-state-card">
            <div class="empty-state-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
              </svg>
            </div>
            <h3 class="empty-state-title">No Study Material Uploaded Yet</h3>
            <p class="empty-state-desc">
              Upload a PDF, lecture slides, YouTube link, or notes in the Study Material tab to extract your course concepts and generate custom smart study notes.
            </p>
            <a href="#upload" class="btn btn-primary" style="margin-top:0.5rem;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="16" x2="12" y2="15"/></svg>
              Upload Study Material &rarr;
            </a>
          </div>
        `;
      }

      if (!AppState.smartNotes.selectedConceptId || !conceptsList.some(c => c.id === AppState.smartNotes.selectedConceptId)) {
        AppState.smartNotes.selectedConceptId = conceptsList[0].id;
      }

      // Fetch saved notes archive
      let savedNotes = [];
      try {
        savedNotes = await ApiService.getNotes(null, userId);
        AppState.smartNotes.savedNotes = savedNotes;
      } catch (e) {
        console.warn("Could not fetch saved notes archive", e);
      }

      const selectedTask = AppState.smartNotes.selectedTask;
      const activeNote = AppState.smartNotes.activeNote;

      return `
        <div class="smart-notes-container">
          <!-- Page Header -->
          <div class="page-header">
            <div class="page-header-text">
              <h1 class="page-title">Smart Study Notes</h1>
              <p class="page-subtitle">
                Elicit targeted study formats grounded in primary material chunks with ElevenLabs voice notes, PDF handouts, and PPTX slide decks.
              </p>
            </div>
          </div>

          <!-- Step 1: Pre-Generation Task Selector -->
          <div class="task-selector-section">
            <div class="task-selector-header">
              <div>
                <h3 style="margin:0 0 0.25rem 0; font-size:1.15rem; font-family:var(--font-heading); color:var(--ink-primary);">
                  Step 1: Select Target Task Format <span class="status-pill weak" style="font-size:0.75rem; vertical-align:middle; margin-left:0.4rem;">Required</span>
                </h3>
                <p style="margin:0; font-size:0.86rem; color:var(--ink-muted);">
                  Students must select an evaluation format before generating notes to align with cognitive task demands.
                </p>
              </div>
            </div>

            <!-- Task Selector 5 Cards: ('exam', 'test', 'quiz', 'viva', 'custom') -->
            <div class="task-selector-grid" id="task-selector-grid">
              <div class="task-card ${selectedTask === 'exam' ? 'selected' : ''}" data-task="exam">
                <div class="task-card-icon">📝</div>
                <div class="task-card-title">
                  <span>Exam Prep</span>
                  <span class="task-card-check">&check;</span>
                </div>
                <p class="task-card-desc">High-yield derivations, step-by-step formulas, common exam traps, and worked numerical problems.</p>
              </div>

              <div class="task-card ${selectedTask === 'test' ? 'selected' : ''}" data-task="test">
                <div class="task-card-icon">🎯</div>
                <div class="task-card-title">
                  <span>Practice Test</span>
                  <span class="task-card-check">&check;</span>
                </div>
                <p class="task-card-desc">Timed diagnostic problems, point-weighted exam scenarios, trap analysis, and verified model answer key.</p>
              </div>

              <div class="task-card ${selectedTask === 'quiz' ? 'selected' : ''}" data-task="quiz">
                <div class="task-card-icon">⚡</div>
                <div class="task-card-title">
                  <span>Quiz Cheat Sheet</span>
                  <span class="task-card-check">&check;</span>
                </div>
                <p class="task-card-desc">Rapid review triggers, invariant properties, edge-case traps, and high-speed formula reference sheet.</p>
              </div>

              <div class="task-card ${selectedTask === 'viva' ? 'selected' : ''}" data-task="viva">
                <div class="task-card-icon">🎙️</div>
                <div class="task-card-title">
                  <span>Viva / Oral Defense</span>
                  <span class="task-card-check">&check;</span>
                </div>
                <p class="task-card-desc">30-second elevator pitch, intuitive real-world analogy, and counter-arguments for examiner probes.</p>
              </div>

              <div class="task-card ${selectedTask === 'custom' ? 'selected' : ''}" data-task="custom">
                <div class="task-card-icon">💡</div>
                <div class="task-card-title">
                  <span>Custom Option</span>
                  <span class="task-card-check">&check;</span>
                </div>
                <p class="task-card-desc">Define custom study requirements, specific rubric targets, or specialized problem-solving focus.</p>
              </div>
            </div>

            <!-- Validation Error Alert -->
            <div class="task-selector-error-msg" id="task-selector-error">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span>Please select your task type (Exam Prep, Practice Test, Quiz Cheat Sheet, Viva / Oral Defense, or Custom Option) before generating notes.</span>
            </div>

            <!-- Custom Instructions Box (Toggled for Custom Prompt) -->
            <div class="custom-prompt-container ${selectedTask === 'custom' ? 'visible' : ''}" id="custom-prompt-box">
              <label for="custom-instructions-input" style="display:block; font-size:0.86rem; font-weight:600; margin-bottom:0.35rem; color:var(--ink-primary);">
                Custom Instructions &amp; Guidance:
              </label>
              <textarea id="custom-instructions-input" rows="2" class="form-input" style="width:100%; border-radius:var(--radius-md); padding:0.65rem; font-family:inherit; font-size:0.9rem;" placeholder="E.g., Include asymptotic runtime proof, emphasize recursion tree diagrams, and add boundary condition traps...">${esc(AppState.smartNotes.customInstructions || '')}</textarea>
            </div>

            <!-- Step 2: Concept Selector & Generation Button -->
            <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:1rem; margin-top:1.25rem; border-top:1px solid var(--border-subtle); padding-top:1.25rem;">
              <div style="display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap;">
                <label for="smart-notes-concept-select" style="font-size:0.88rem; font-weight:600; color:var(--ink-secondary);">
                  Target Concept:
                </label>
                <select id="smart-notes-concept-select" class="form-input" style="min-width:240px; padding:0.55rem 0.85rem; border-radius:var(--radius-md); font-weight:600;">
                  ${conceptsList.map(c => `
                    <option value="${esc(c.id)}" ${c.id === AppState.smartNotes.selectedConceptId ? 'selected' : ''}>
                      ${esc(c.label)}
                    </option>
                  `).join('')}
                </select>
              </div>

              <button id="btn-generate-smart-notes" class="btn btn-primary" style="padding:0.65rem 1.4rem; gap:0.5rem; font-weight:700;">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
                </svg>
                <span>Generate Smart Notes</span>
              </button>
            </div>
          </div>

          <!-- Step 3: Active Generated Note View -->
          ${activeNote ? `
            <div class="note-content-card" id="active-note-view">
              <!-- Note Action Bar -->
              <div class="note-action-bar">
                <div class="note-action-buttons">
                  <button class="btn btn-sm btn-outline" id="btn-note-audio" title="Synthesize executive spoken summary with ElevenLabs Flash">
                    🎧 Listen to Audio Note (ElevenLabs Flash)
                  </button>
                  <button class="btn btn-sm btn-outline" id="btn-note-pdf" title="Download printable PDF handout">
                    📄 Download PDF
                  </button>
                  <button class="btn btn-sm btn-outline" id="btn-note-pptx" title="Export 5-slide PPTX deck">
                    📊 Export PPTX
                  </button>
                  <button class="btn btn-sm btn-outline" id="btn-note-diagram" title="Generate grounded SVG architectural diagram">
                    🖼️ Generate Diagram
                  </button>
                </div>
                <div style="font-size:0.8rem; color:var(--ink-muted);">
                  Grounded in <strong>${esc(activeNote.citations?.length || 1)} source citations</strong>
                </div>
              </div>

              <!-- Inline HTML5 Audio Player -->
              <div class="note-audio-player-container ${activeNote.audio_url || AppState.smartNotes.activeAudioUrl ? 'visible' : ''}" id="note-audio-player-box">
                <span style="font-size:0.86rem; font-weight:700; color:var(--primary); white-space:nowrap;">
                  🎧 Spoken Summary:
                </span>
                <audio controls src="${esc(ApiService.getArtifactUrl(activeNote.audio_url || AppState.smartNotes.activeAudioUrl || ''))}" style="flex:1; height:36px;" id="note-audio-element"></audio>
                <a href="${esc(ApiService.getArtifactUrl(activeNote.audio_url || AppState.smartNotes.activeAudioUrl || ''))}" download class="btn btn-xs btn-outline" style="white-space:nowrap;">
                  Save MP3
                </a>
              </div>

              <!-- Inline Diagram SVG Container -->
              <div class="note-diagram-wrapper" id="note-diagram-box" style="${AppState.smartNotes.diagramSvg ? '' : 'display:none;'}">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
                  <strong style="font-size:0.9rem; color:var(--ink-primary);">🖼️ Concept Flow Diagram</strong>
                  <span style="font-size:0.75rem; color:var(--ink-muted);">Interactive SVG</span>
                </div>
                <div id="note-diagram-inner" style="max-height:380px; overflow:auto;">
                  ${AppState.smartNotes.diagramSvg || ''}
                </div>
              </div>

              <!-- Note Title & Header Metadata -->
              <div class="note-header">
                <div class="note-badge-row">
                  <span class="status-pill strong">${esc((activeNote.task_type || 'exam').toUpperCase())} NOTE</span>
                  <span style="font-size:0.82rem; color:var(--ink-muted); font-weight:600;">${esc(activeNote.concept_id?.replace(/_/g, ' ').toUpperCase() || 'CONCEPT')}</span>
                  ${activeNote.created_at ? `<span style="font-size:0.8rem; color:var(--ink-faint); margin-left:auto;">${esc(activeNote.created_at.slice(0, 10))}</span>` : ''}
                </div>
                <h2 style="margin:0.25rem 0; font-size:1.6rem; font-family:var(--font-heading); color:var(--ink-primary);">
                  ${esc(activeNote.title || 'Smart Study Note')}
                </h2>
              </div>

              <!-- High-Yield Key Takeaways -->
              ${activeNote.key_takeaways && activeNote.key_takeaways.length ? `
                <div class="note-takeaways-box">
                  <h4>⚡ High-Yield Key Takeaways</h4>
                  <ul class="note-takeaways-list">
                    ${activeNote.key_takeaways.map(t => `<li>${formatGroundedCitations(esc(t))}</li>`).join('')}
                  </ul>
                </div>
              ` : ''}

              <!-- Rendered Markdown Body -->
              <div class="note-markdown-body" id="note-markdown-body">
                ${formatMarkdownNotes(activeNote.markdown_content || '')}
              </div>
            </div>
          ` : ''}

          <!-- Step 4: Saved Notes Archive List -->
          <div class="archive-section">
            <div class="archive-header">
              <div>
                <h3 style="margin:0 0 0.25rem 0; font-size:1.2rem; font-family:var(--font-heading); color:var(--ink-primary);">
                  📚 Saved Notes Archive (${savedNotes.length})
                </h3>
                <p style="margin:0; font-size:0.84rem; color:var(--ink-muted);">
                  Previously generated notes with instant re-read, audio review, and multi-format export.
                </p>
              </div>
            </div>

            ${savedNotes.length ? `
              <div class="saved-notes-grid" id="saved-notes-grid">
                ${savedNotes.map(n => `
                  <div class="saved-note-card" data-note-id="${esc(n.note_id)}">
                    <div>
                      <div class="saved-note-meta">
                        <span class="status-pill strong" style="font-size:0.72rem; padding:0.15rem 0.5rem;">${esc((n.task_type || 'exam').toUpperCase())}</span>
                        <span>&bull;</span>
                        <span style="font-weight:600;">${esc(n.concept_id?.replace(/_/g, ' ') || 'Concept')}</span>
                        ${n.created_at ? `<span style="margin-left:auto; font-size:0.75rem;">${esc(n.created_at.slice(0, 10))}</span>` : ''}
                      </div>
                      <div class="saved-note-title">${esc(n.title || 'Study Note')}</div>
                      <div style="font-size:0.82rem; color:var(--ink-secondary); line-height:1.45; max-height:3.6em; overflow:hidden;">
                        ${esc(n.key_takeaways?.[0] || (n.markdown_content || '').slice(0, 120))}...
                      </div>
                    </div>
                    <div class="saved-note-actions">
                      <button class="btn btn-xs btn-primary btn-read-saved-note" data-id="${esc(n.note_id)}">
                        📖 Read
                      </button>
                      <button class="btn btn-xs btn-outline btn-audio-saved-note" data-id="${esc(n.note_id)}" data-url="${esc(n.audio_url || '')}">
                        🎧 Audio
                      </button>
                      <button class="btn btn-xs btn-outline btn-pdf-saved-note" data-id="${esc(n.note_id)}" data-url="${esc(n.pdf_url || '')}">
                        📄 PDF
                      </button>
                      <button class="btn btn-xs btn-outline btn-pptx-saved-note" data-id="${esc(n.note_id)}" data-url="${esc(n.pptx_url || '')}">
                        📊 PPTX
                      </button>
                      <button class="btn btn-xs btn-outline btn-delete-saved-note" data-id="${esc(n.note_id)}" style="color:var(--color-danger); border-color:var(--color-danger-border); margin-left:auto;" title="Delete note">
                        🗑️
                      </button>
                    </div>
                  </div>
                `).join('')}
              </div>
            ` : `
              <div class="card" style="padding:2.5rem; text-align:center; color:var(--ink-muted);">
                <div style="font-size:2rem; margin-bottom:0.5rem;">📚</div>
                <h4 style="margin:0 0 0.25rem 0; color:var(--ink-secondary);">No Saved Notes Yet</h4>
                <p style="margin:0; font-size:0.86rem;">Select a task type and concept above to generate your first high-yield smart study guide.</p>
              </div>
            `}
          </div>
        </div>
      `;
    },

    // -----------------------------------------------------------------------
    // D. CONCEPT CHECK / QUIZ VIEW
    // -----------------------------------------------------------------------
    async practice() {
      await syncActiveDocument();
      if (!AppState.masteryList || !AppState.masteryList.length) {
        try {
          const mRes = await ApiService.getMastery();
          AppState.masteryList = mRes.concepts || [];
        } catch (e) {
          console.warn("Could not load mastery list for practice view", e);
        }
      }

      const activeConceptId = AppState.quizSession.targetConceptId || AppState.quizSession.currentConceptId || "";
      const conceptOptions = (AppState.masteryList || []).map(c => `
        <option value="${esc(c.id)}" ${c.id === activeConceptId ? "selected" : ""}>
          ${esc(c.name || c.id)}
        </option>
      `).join("");

      return `
        <div class="page-header" style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:1rem;">
          <div class="page-header-text">
            <h1>Concept Check</h1>
            <p>Test your understanding of key concepts with adaptive questions generated from verified material.</p>
          </div>
          <div class="page-header-actions" style="display:flex; align-items:center; gap:0.6rem;">
            <label for="practice-topic-select" style="font-size:0.85rem; font-weight:600; color:var(--ink-secondary);">Topic:</label>
            <select id="practice-topic-select" class="form-select" style="padding:0.45rem 0.85rem; border-radius:var(--radius-sm); border:1px solid var(--border-subtle); background:var(--surface); font-size:0.88rem; font-weight:600; color:var(--ink-primary); cursor:pointer;">
              <option value="">🎯 Auto-Adaptive (All Concepts)</option>
              ${conceptOptions}
            </select>
          </div>
        </div>

        <div class="quiz-container" id="quiz-wrapper">
          <div class="card quiz-main-card" id="quiz-card-box">
            <div style="padding:2.5rem; text-align:center;">
              <div class="upload-icon-pulse" style="width:48px; height:48px;">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              </div>
              <h3 style="margin-bottom:0.5rem;">Loading Adaptive Assessment...</h3>
              <p>Selecting targeted concept based on epistemic belief engine...</p>
            </div>
          </div>

          <!-- Quiz Side Panel: Live Gauge & Concept Tip -->
          <div style="display:flex; flex-direction:column; gap:1.25rem;">
            <div class="card" style="text-align:center;">
              <h4 style="margin-bottom:1rem; color:var(--ink-secondary);">Session Performance</h4>
              <div class="donut-chart-container" style="margin: 0 auto;">
                <div id="quiz-perf-donut">
                  ${createDonutSvg(0, 110, 8, "var(--primary)")}
                </div>
                <div class="donut-chart-value">
                  <span class="val-number" id="quiz-perf-number">0%</span>
                  <span class="val-label">Accuracy</span>
                </div>
              </div>
              <p style="margin-top:0.85rem; font-size:0.85rem;" id="quiz-encouragement">
                Keep going! Every answer sharpens your mastery profile.
              </p>
            </div>

            <div class="card" style="background:var(--surface-subtle); border-color:var(--border-subtle);">
              <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.5rem; color:var(--color-weak-text);">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
                <span style="font-weight:700; font-size:0.85rem;">Study Tip</span>
              </div>
              <p style="font-size:0.82rem; margin:0;" id="quiz-sidebar-tip">
                Answer independently. The Multi-Agent Pedagogical Assessment system evaluates genuine conceptual reasoning and cognitive depth.
              </p>
            </div>
          </div>
        </div>
      `;
    },

    // -----------------------------------------------------------------------
    // E. LEARNING PATH VIEW
    // -----------------------------------------------------------------------
    async learningPath() {
      await syncActiveDocument();
      let masteryData = [];
      let graphData = { nodes: [], edges: [] };

      try {
        const [mRes, gRes] = await Promise.all([
          ApiService.getMastery(),
          ApiService.getGraph()
        ]);
        masteryData = mRes.concepts || [];
        graphData = gRes || { nodes: [], edges: [] };
        AppState.masteryList = masteryData;
        AppState.graphData = graphData;
      } catch (e) {
        console.warn("Could not fetch learning path", e);
      }

      if (!masteryData.length) {
        return `
          <div class="page-header">
            <div class="page-header-text">
              <h1>Your Learning Path</h1>
              <p>A personalized roadmap based on prerequisite concepts and current mastery.</p>
            </div>
          </div>
          <div class="card" style="padding:3.5rem; text-align:center;">
            <h3>No Concept Graph Available</h3>
            <p style="margin:0.5rem 0 1.5rem 0;">Upload study material first to generate the prerequisite graph.</p>
            <a href="#upload" class="btn btn-primary">Go to Study Material &rarr;</a>
          </div>
        `;
      }

      return `
        <div class="page-header">
          <div class="page-header-text">
            <h1>Your Learning Path</h1>
            <p>A personalized roadmap based on your performance and prerequisite dependencies.</p>
          </div>
          <div class="page-header-actions">
            <button id="toggle-graph-view" class="btn btn-secondary">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
              Toggle Topological Graph
            </button>
          </div>
        </div>

        <!-- Optional Full Graph Canvas (Hidden by default) -->
        <div id="full-graph-container" style="display:none; margin-bottom:1.75rem;" class="graph-canvas-wrap">
          <div class="card-header">
            <h3 class="card-title">Directed Prerequisite Dependency Graph</h3>
            <span style="font-size:0.8rem; color:var(--ink-muted);">Arrows point from prerequisite &rarr; downstream concept</span>
          </div>
          <div id="graph-svg-box">
            ${renderGraphSvg(graphData, masteryData)}
          </div>
        </div>

        <div class="grid grid-split-path">
          <!-- Left Column: Ordered Concept Roadmap Timeline -->
          <div class="card">
            <div class="card-header">
              <h3 class="card-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
                Concept Milestones
              </h3>
              <span class="active-doc-badge">Prerequisite Sequence</span>
            </div>

            <div class="roadmap-timeline">
              ${masteryData.map((c, i) => {
                const st = getConceptStatus(c);
                const scorePercent = (c.attempts && c.attempts > 0) ? Math.round((c.score || 0) * 100) : 0;
                let actionBtn = `<a href="#practice" data-target-concept="${esc(c.id)}" class="btn btn-primary btn-sm start-target-quiz">Practice</a>`;
                let statusLabel = "Not Assessed";

                if (st === "strong") {
                  statusLabel = "Mastered";
                  actionBtn = `<a href="#practice" data-target-concept="${esc(c.id)}" class="btn btn-secondary btn-sm start-target-quiz">Review</a>`;
                } else if (st === "weak") {
                  statusLabel = "Needs Review";
                  actionBtn = `<a href="#practice" data-target-concept="${esc(c.id)}" class="btn btn-primary btn-sm start-target-quiz" style="background:var(--color-weak);">Strengthen</a>`;
                }

                return `
                  <div class="roadmap-node-card ${st}">
                    <span class="roadmap-status-dot"></span>
                    <div>
                      <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.25rem;">
                        <span style="font-weight:700; font-size:1.05rem;">${esc(c.name)}</span>
                        <span class="status-pill ${st}">${statusLabel}</span>
                      </div>
                      <p style="font-size:0.82rem; margin:0; color:var(--ink-muted);">
                        ${c.attempts || 0} answer(s) · Belief: <strong>${scorePercent}%</strong>
                        ${c.why ? `· ${esc(c.why)}` : ""}
                      </p>
                    </div>

                    <div style="display:flex; align-items:center; gap:0.5rem;">
                      ${actionBtn}
                      <button class="btn btn-secondary btn-sm inspect-concept-btn" data-cid="${esc(c.id)}">Details</button>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          </div>

          <!-- Right Column: Concept Mastery Radar / Spider Visualization -->
          <div class="card radar-chart-card">
            <h3 style="margin-bottom:0.4rem; font-size:1.15rem;">Concept Mastery Radar</h3>
            <p style="font-size:0.8rem; margin-bottom:1.5rem; color:var(--ink-muted);">Comparing current belief score vs target 100% mastery</p>

            ${createRadarSvg(masteryData)}

            <div style="display:flex; gap:1.5rem; margin-top:1.5rem; font-size:0.82rem;">
              <div style="display:flex; align-items:center; gap:0.45rem;">
                <span style="width:12px; height:12px; background:var(--primary); border-radius:2px;"></span>
                <span style="font-weight:600;">You (Estimated)</span>
              </div>
              <div style="display:flex; align-items:center; gap:0.45rem;">
                <span style="width:12px; height:12px; border:1px dashed var(--primary-border); background:rgba(37,99,235,0.1); border-radius:2px;"></span>
                <span style="font-weight:600; color:var(--ink-muted);">Target Mastery</span>
              </div>
            </div>

            <div style="margin-top:1.75rem; width:100%; text-align:left; border-top:1px solid var(--border-subtle); padding-top:1.25rem;">
              <h4 style="font-size:0.9rem; margin-bottom:0.5rem;">Why this order matters</h4>
              <p style="font-size:0.82rem; line-height:1.5; color:var(--ink-secondary);">
                Concepts are sorted by prerequisite depth. If a foundational concept is weak, practicing downstream concepts first often fails because the prerequisite knowledge isn't solid yet.
              </p>
            </div>
          </div>
        </div>
      `;
    },

    // -----------------------------------------------------------------------
    // F. PROGRESS & MASTERY ANALYTICS VIEW
    // -----------------------------------------------------------------------
    async progress() {
      await syncActiveDocument();
      let masteryData = [];
      try {
        const res = await ApiService.getMastery();
        masteryData = res.concepts || [];
        AppState.masteryList = masteryData;
      } catch (e) {
        console.warn("Could not fetch mastery snapshot", e);
      }

      const total = masteryData.length;
      const strongCount = masteryData.filter(c => getConceptStatus(c) === "strong").length;
      const weakCount = masteryData.filter(c => getConceptStatus(c) === "weak").length;
      const unknownCount = masteryData.filter(c => getConceptStatus(c) === "unknown").length;
      const avg = total > 0 ? Math.round((masteryData.reduce((acc, c) => acc + ((c.attempts && c.attempts > 0) ? (c.score || 0) : 0), 0) / total) * 100) : 0;

      // ── Empty-State Gating for Mastery Analytics ─────────────────────────
      if (total === 0) {
        return `
          <div class="page-header">
            <div class="page-header-text">
              <h1>Progress &amp; Mastery Analytics</h1>
              <p>Multi-Agent Pedagogical Assessment (4 Specialist Teachers + Head Teacher Arbiter).</p>
            </div>
            <div class="page-header-actions">
              <button class="btn btn-secondary btn-disabled-gated" disabled title="Upload study material first">Take Practice Quiz</button>
            </div>
          </div>

          <div class="empty-state-card">
            <div class="empty-state-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
                <path d="M12 12v9"/>
                <path d="m16 16-4-4-4 4"/>
              </svg>
            </div>
            <h3 class="empty-state-title">No Study Material Uploaded Yet</h3>
            <p class="empty-state-desc">
              No study material uploaded yet. Upload a PDF, lecture slides, YouTube link, or notes in the Study Material tab to generate your custom learning path.
            </p>
            <a href="#upload" class="btn btn-primary" style="margin-top:0.5rem;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Upload Study Material &rarr;
            </a>
          </div>
        `;
      }

      const isBaselineDone = (AppState.baselineCompleted || (AppState.loopStatus && AppState.loopStatus.baseline_completed));

      return `
        <div class="page-header">
          <div class="page-header-text">
            <h1>Progress &amp; Mastery Analytics</h1>
            <p>Multi-Agent Pedagogical Assessment (4 Specialist Teachers + Head Teacher Arbiter).</p>
          </div>
          <div class="page-header-actions">
            ${isBaselineDone ? `
              <a href="#practice" class="btn btn-primary">Take Practice Quiz</a>
            ` : `
              <button class="btn btn-secondary btn-disabled-gated" disabled title="Complete baseline diagnostic first">Take Practice Quiz</button>
            `}
          </div>
        </div>

        <!-- 4 KPI Cards -->
        <div class="grid grid-cols-4" style="margin-bottom: 1.75rem;">
          <div class="card" style="text-align:center;">
            <span style="font-size:0.75rem; text-transform:uppercase; color:var(--ink-muted); font-weight:700;">Overall Mastery</span>
            <h2 style="font-size:2rem; margin:0.35rem 0; color:var(--primary);">${avg}%</h2>
            <span style="font-size:0.75rem; color:var(--ink-secondary);">Multi-Agent evaluation</span>
          </div>

          <div class="card" style="text-align:center;">
            <span style="font-size:0.75rem; text-transform:uppercase; color:var(--color-strong); font-weight:700;">Mastered Concepts</span>
            <h2 style="font-size:2rem; margin:0.35rem 0; color:var(--color-strong);">${strongCount}</h2>
            <span style="font-size:0.75rem; color:var(--ink-secondary);">Verified authentic comprehension</span>
          </div>

          <div class="card" style="text-align:center;">
            <span style="font-size:0.75rem; text-transform:uppercase; color:var(--color-weak); font-weight:700;">Not Yet Mastered</span>
            <h2 style="font-size:2rem; margin:0.35rem 0; color:var(--color-weak);">${weakCount}</h2>
            <span style="font-size:0.75rem; color:var(--ink-secondary);">Identified misconceptions or gaps</span>
          </div>

          <div class="card" style="text-align:center;">
            <span style="font-size:0.75rem; text-transform:uppercase; color:var(--color-unknown); font-weight:700;">Needs Evidence</span>
            <h2 style="font-size:2rem; margin:0.35rem 0; color:var(--color-unknown);">${unknownCount}</h2>
            <span style="font-size:0.75rem; color:var(--ink-secondary);">Awaiting diagnostic evidence</span>
          </div>
        </div>

        <!-- Multi-Agent Assessment Explanation Banner -->
        <div class="card" style="margin-bottom:1.75rem; background:var(--surface-subtle); border-color:var(--border-subtle);">
          <div style="display:flex; align-items:flex-start; gap:0.85rem;">
            <div style="width:32px; height:32px; border-radius:50%; background:var(--primary-light); color:var(--primary); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </div>
            <div>
              <h4 style="font-size:0.95rem; margin-bottom:0.25rem;">Multi-Agent Pedagogical Assessment System</h4>
              <p style="font-size:0.85rem; margin:0; line-height:1.5;">
                Rather than using crude numerical scores or formulas, your mastery is deliberated by four specialist pedagogical teachers (Teaching Agent, Assessment Agent, Misconception Detective, and Learning Observer) and arbitrated by the Head Teacher. Decisions evaluate genuine understanding, cognitive transfer, and mental models.
              </p>
            </div>
          </div>
        </div>

        <!-- Detailed Concept Mastery Table -->
        <div class="mastery-table-wrap">
          <table class="mastery-table">
            <thead>
              <tr>
                <th>Concept</th>
                <th>Pedagogical Outcome</th>
                <th>Assessment Status</th>
                <th>Evidence Records</th>
                <th>Diagnostic Explanation</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${masteryData.length === 0 ? `
                <tr><td colspan="6" style="text-align:center; padding:2rem; color:var(--ink-muted);">No concepts assessed yet. Upload material and take a quiz.</td></tr>
              ` : masteryData.map(c => {
                const st = getConceptStatus(c);
                const badge = renderOutcomeBadge(c);
                return `
                  <tr>
                    <td><strong>${esc(c.name)}</strong></td>
                    <td>${badge}</td>
                    <td><span class="status-pill ${st}">${st.toUpperCase()}</span></td>
                    <td>${c.attempts || 0} interaction(s)</td>
                    <td style="max-width:320px; font-size:0.82rem; color:var(--ink-secondary);">${esc(c.why || c.explainable_summary || "Multi-Agent assessment active")}</td>
                    <td>
                      <div style="display:flex; gap:0.4rem; align-items:center;">
                        <button class="btn btn-outline btn-sm btn-inspect-deliberation" data-concept-id="${esc(c.id)}" data-concept-name="${esc(c.name)}" title="Inspect Deliberation">Inspect Deliberation</button>
                        <a href="#tutor" class="btn btn-secondary btn-sm" title="Ask Tutor">Ask</a>
                        <a href="#practice" data-target-concept="${esc(c.id)}" class="btn btn-primary btn-sm start-target-quiz" title="Quiz this concept">Quiz</a>
                      </div>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      `;
    },

    // -----------------------------------------------------------------------
    // G. SETTINGS VIEW
    // -----------------------------------------------------------------------
    async settings() {
      const conf = ApiService.getConfig();
      let healthOk = false;
      try {
        const h = await ApiService.getHealth();
        healthOk = Boolean(h && h.ok);
      } catch (e) {
        healthOk = false;
      }

      return `
        <div class="page-header">
          <div class="page-header-text">
            <h1>Platform Settings</h1>
            <p>Manage local preferences, student profile, and verified backend connections.</p>
          </div>
        </div>

        <div class="grid grid-cols-2">
          <!-- Profile & Appearance -->
          <div class="card">
            <h3 style="margin-bottom:1.25rem;">Profile &amp; Appearance</h3>
            <div style="display:flex; flex-direction:column; gap:1.25rem;">
              <div>
                <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:0.4rem;">Student Name</label>
                <input type="text" id="setting-student-name" value="${esc(AppState.studentName)}" style="padding:0.65rem 0.85rem; border:1px solid var(--border-subtle); border-radius:var(--radius-md); width:100%; background:var(--surface-subtle); color:var(--ink-primary);">
              </div>

              <div>
                <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:0.4rem;">Color Theme</label>
                <div style="display:flex; gap:0.75rem;">
                  <button class="btn btn-secondary btn-sm theme-select-btn" data-set-theme="light">Light Theme</button>
                  <button class="btn btn-secondary btn-sm theme-select-btn" data-set-theme="dark">Dark Theme</button>
                </div>
              </div>

              <div style="padding-top:0.75rem; border-top:1px solid var(--border-subtle);">
                <button class="btn btn-primary" id="btn-save-settings">Save Preferences</button>
              </div>
            </div>
          </div>

          <!-- Backend Diagnostics -->
          <div class="card">
            <h3 style="margin-bottom:1.25rem;">Backend Architecture</h3>
            <div style="display:flex; flex-direction:column; gap:1rem;">
              <div style="display:flex; justify-content:space-between; align-items:center; padding:0.75rem; background:var(--surface-subtle); border-radius:var(--radius-md);">
                <span style="font-weight:600; font-size:0.88rem;">Server Status</span>
                <span class="status-pill ${healthOk ? 'strong' : 'weak'}">${healthOk ? 'Connected (FastAPI)' : 'Unreachable'}</span>
              </div>

              <div>
                <label style="display:block; font-size:0.85rem; font-weight:600; margin-bottom:0.4rem;">Backend Base URL</label>
                <input type="text" id="setting-backend-base" value="${esc(conf.base)}" placeholder="e.g. http://localhost:8000 (empty for same host)" style="padding:0.65rem 0.85rem; border:1px solid var(--border-subtle); border-radius:var(--radius-md); width:100%; background:var(--surface-subtle); color:var(--ink-primary);">
              </div>

              <div style="display:flex; align-items:center; gap:0.6rem;">
                <input type="checkbox" id="setting-mock-mode" ${conf.mock ? 'checked' : ''} style="width:18px; height:18px;">
                <label for="setting-mock-mode" style="font-size:0.88rem; font-weight:600;">Enable offline demo dataset (Mock mode)</label>
              </div>

              <div style="padding-top:0.75rem; border-top:1px solid var(--border-subtle); display:flex; justify-content:space-between; align-items:center;">
                <button class="btn btn-secondary" id="btn-ping-backend">Ping Health Check</button>
                <button class="btn btn-outline" id="btn-reset-mastery" style="color:var(--color-danger); border-color:var(--color-danger-border);">Reset Mastery</button>
              </div>
              <div id="settings-diag-output" style="font-size:0.8rem; color:var(--ink-muted);"></div>
            </div>
          </div>
        </div>
      `;
    }
  };

  // Helper to render chat message
  function renderChatMessage(msg) {
    const isUser = msg.sender === "user";
    const citationsHtml = msg.citations && msg.citations.length > 0 ? `
      <div class="citation-block">
        ${msg.citations.map((c, i) => {
          if (c.source_type === "web" || c.url) {
            return `
              <a href="${esc(c.url || '#')}" target="_blank" rel="noopener noreferrer" class="citation-chip web-citation-chip" style="text-decoration:none; display:inline-flex; align-items:center; gap:0.35rem; color:var(--primary);">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
                <span>${esc(c.snippet || c.title || "Web Source")} &nearr;</span>
              </a>
            `;
          }
          return `
            <button class="citation-chip view-citation-btn" data-page="${c.page || 1}" data-snippet="${esc(c.snippet)}" data-text="${esc(c.text || '')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              <span>Page ${c.page || 1}: <strong>${esc(c.snippet || "Section")}</strong> &rarr;</span>
            </button>
          `;
        }).join("")}
      </div>
    ` : "";

    const artifactsHtml = (msg.artifacts && msg.artifacts.length > 0) ? `
      <div class="chat-artifacts-container">
        ${msg.artifacts.map(art => {
          const rawUrl = art.url || art.download_url || art.filename || "";
          const artUrl = ApiService.getArtifactUrl(rawUrl);
          const isSvg = art.type === "visual" || rawUrl.endsWith(".svg");
          const isAudio = art.type === "audio" || rawUrl.endsWith(".mp3");
          const isPptx = art.type === "pptx" || rawUrl.endsWith(".pptx");
          const isPdf = art.type === "pdf" || rawUrl.endsWith(".pdf");
          let icon = "📄";
          if (isSvg) icon = "🖼️";
          else if (isAudio) icon = "🎧";
          else if (isPptx) icon = "📊";
          else if (isPdf) icon = "📑";

          return `
            <div class="chat-artifact-card">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; align-items:center; gap:0.5rem;">
                  <span style="font-size:1.1rem;">${icon}</span>
                  <div>
                    <strong style="font-size:0.88rem; color:var(--ink-primary);">${esc(art.title || art.filename || "Study Artifact")}</strong>
                    <div style="font-size:0.75rem; color:var(--ink-muted);">${esc(art.type ? art.type.toUpperCase() : "ARTIFACT")} &bull; Grounded Material</div>
                  </div>
                </div>
                ${artUrl ? `
                  <a href="${esc(artUrl)}" download class="btn btn-xs btn-primary" style="text-decoration:none;">
                    Download
                  </a>
                ` : ''}
              </div>
              ${isAudio && artUrl ? `
                <audio controls src="${esc(artUrl)}" style="width:100%; margin-top:0.4rem; height:36px;"></audio>
              ` : ''}
              ${isSvg && art.svg ? `
                <div style="max-height:220px; overflow:auto; background:#ffffff; padding:0.5rem; border-radius:var(--radius-sm); border:1px solid var(--border-subtle); margin-top:0.4rem;">
                  ${art.svg}
                </div>
              ` : ''}
            </div>
          `;
        }).join("")}
      </div>
    ` : "";

    const linksHtml = (msg.external_links && msg.external_links.length > 0) ? `
      <div class="chat-external-links">
        ${msg.external_links.map(link => `
          <a href="${esc(link.url || '#')}" target="_blank" rel="noopener noreferrer" class="chat-external-card">
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span style="background:var(--surface-brand); color:var(--primary); font-weight:700; font-size:0.75rem; padding:0.15rem 0.45rem; border-radius:4px;">External Resource</span>
              <span style="font-weight:600;">${esc(link.title || link.url)}</span>
            </div>
            <span style="color:var(--primary); font-size:0.9rem;">&nearr;</span>
          </a>
        `).join("")}
      </div>
    ` : "";

    return `
      <div class="chat-row ${isUser ? 'user' : 'assistant'}">
        <div class="chat-avatar ${isUser ? 'user-avatar' : 'bot-avatar'}">
          ${isUser ? esc(AppState.studentName[0] || 'A') : `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
          `}
        </div>
        <div class="message-bubble">
          <div>${msg.text}</div>
          ${citationsHtml}
          ${artifactsHtml}
          ${linksHtml}
        </div>
      </div>
    `;
  }

  // Helper to render graph SVG
  function renderGraphSvg(graph, mastery) {
    if (!graph.nodes || !graph.nodes.length) {
      return `<p style="color:var(--ink-muted); text-align:center; padding:2rem;">No nodes in prerequisite graph.</p>`;
    }

    const byId = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
    const statusMap = Object.fromEntries((mastery || []).map(m => [m.id, getConceptStatus(m)]));
    const colors = {
      strong: "var(--color-strong)",
      weak: "var(--color-weak)",
      unknown: "var(--color-unknown)"
    };

    const maxY = Math.max(300, ...graph.nodes.map(n => (n.y || 0) + 70));

    const lines = (graph.edges || []).map(([from, to]) => {
      const a = byId[from];
      const b = byId[to];
      if (!a || !b) return "";
      return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="var(--ink-muted)" stroke-width="2" marker-end="url(#arrowhead)" opacity="0.5"/>`;
    }).join("");

    const nodes = graph.nodes.map(n => {
      const st = statusMap[n.id] || "unknown";
      const col = colors[st];
      return `
        <g class="graph-node-group" style="cursor:pointer;" data-cid="${esc(n.id)}" data-name="${esc(n.name)}">
          <title>${esc(n.name)} (${st.toUpperCase()}) - Click to practice, study, or jump to video</title>
          <circle cx="${n.x}" cy="${n.y}" r="24" fill="${col}" stroke="#ffffff" stroke-width="3" filter="drop-shadow(0 2px 4px rgba(0,0,0,0.15))"/>
          <text x="${n.x}" y="${n.y + 40}" text-anchor="middle" font-size="11" font-weight="600" fill="var(--ink-primary)">${esc(n.name)}</text>
        </g>
      `;
    }).join("");

    return `
      <svg viewBox="0 0 740 ${maxY}" style="width:100%; min-width:600px; height:auto;">
        <defs>
          <marker id="arrowhead" viewBox="0 0 10 10" refX="28" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--ink-muted)" opacity="0.7"/>
          </marker>
        </defs>
        ${lines}
        ${nodes}
      </svg>
    `;
  }

  // =========================================================================
  // VIEW INTERACTION HANDLERS (After Render)
  // =========================================================================

  const AfterRender = {
    dashboard() {
      const diagBtn = $("#btn-start-baseline-diagnostic");
      if (diagBtn) {
        diagBtn.onclick = () => startBaselineDiagnostic();
      }

      $$(".start-remedial-review").forEach(btn => {
        btn.onclick = () => {
          AppState.quizSession.remedialMode = true;
          AppState.quizSession.targetConceptId = btn.getAttribute("data-target-concept");
        };
      });

      $$(".start-target-quiz").forEach(btn => {
        btn.onclick = () => {
          AppState.quizSession.targetConceptId = btn.getAttribute("data-target-concept");
        };
      });

      $$(".journey-step").forEach(step => {
        step.onclick = () => {
          const navTarget = step.getAttribute("data-nav");
          if (navTarget) location.hash = `#${navTarget}`;
        };
      });
    },

    upload() {
      // 1. Tab Navigation
      $$(".upload-tab-btn").forEach(btn => {
        btn.onclick = () => {
          $$(".upload-tab-btn").forEach(b => b.classList.remove("active"));
          $$(".upload-tab-content").forEach(c => c.classList.remove("active"));
          btn.classList.add("active");
          const tab = btn.getAttribute("data-tab");
          const content = $(`#tab-content-${tab}`);
          if (content) content.classList.add("active");
        };
      });

      // 2. File Upload Dropzone & Processing
      const dropzone = $("#upload-dropzone");
      const fileInput = $("#material-file-input") || $("#pdf-file-input");
      const processBtn = $("#btn-process-files") || $("#btn-process-pdf");
      const sampleBtn = $("#btn-load-sample");
      const fileDisplay = $("#selected-file-display");
      const fileNameEl = $("#selected-file-name");
      let selectedFiles = [];

      if (dropzone && fileInput) {
        dropzone.onclick = () => fileInput.click();
      }

      function updateFileSelection(fileList) {
        const allowedExts = [".pdf", ".pptx", ".ppt", ".md", ".txt", ".docx", ".mp3", ".wav", ".m4a", ".webm"];
        const valid = Array.from(fileList || []).filter(f => {
          const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
          return allowedExts.includes(ext);
        });
        if (!valid.length) {
          showToast("Please select valid study material files (PDF, PPTX, DOCX, Markdown, or Audio).", "warning");
          return;
        }
        selectedFiles = valid;
        if (fileNameEl) {
          if (valid.length === 1) {
            fileNameEl.textContent = valid[0].name;
          } else {
            fileNameEl.textContent = `${valid.length} materials selected (${valid.map(f => f.name).join(", ")})`;
          }
        }
        if (fileDisplay) fileDisplay.style.display = "inline-flex";
        if (processBtn) {
          processBtn.disabled = false;
          processBtn.textContent = `Process ${valid.length > 1 ? valid.length + " Materials" : "Study Material"}`;
        }
      }

      if (fileInput) {
        fileInput.onchange = () => {
          if (fileInput.files && fileInput.files.length) {
            updateFileSelection(fileInput.files);
          }
        };
      }

      if (dropzone) {
        ["dragover", "dragenter"].forEach(ev => {
          dropzone.addEventListener(ev, e => {
            e.preventDefault();
            dropzone.classList.add("over");
          });
        });

        ["dragleave", "drop"].forEach(ev => {
          dropzone.addEventListener(ev, e => {
            e.preventDefault();
            dropzone.classList.remove("over");
            if (ev === "drop" && e.dataTransfer.files && e.dataTransfer.files.length) {
              updateFileSelection(e.dataTransfer.files);
            }
          });
        });
      }

      // Process Ingestion for Uploaded Files
      if (processBtn) {
        processBtn.onclick = async () => {
          if (!selectedFiles.length) return;
          processBtn.disabled = true;
          processBtn.textContent = `Ingesting ${selectedFiles.length > 1 ? selectedFiles.length + " materials" : "material"}...`;

          const stages = [$("#stage-1"), $("#stage-2"), $("#stage-3"), $("#stage-4")];
          stages.forEach(s => s && (s.className = "stage-item running"));

          try {
            // If strictly PDFs, call uploadPdf for backward compatibility; otherwise ingestMaterialFile
            let result = await ApiService.ingestMaterialFile(selectedFiles, getCurrentUserId());

            stages.forEach(s => s && (s.className = "stage-item done"));
            showToast("Material ingested successfully into vectorless index!", "success");
            await syncActiveDocument();
            setTimeout(() => {
              navigateTo("upload");
            }, 800);
          } catch (err) {
            stages.forEach(s => s && (s.className = "stage-item"));
            if (isMedicalVerificationRequired(err)) {
              _pendingVerificationUpload = { type: "file", files: selectedFiles };
              showToast("Medical student verification required for this clinical material.", "warning");
              openMedicalVerificationModal(err);
            } else {
              showToast(`Ingestion error: ${err.message}`, "danger");
            }
            processBtn.disabled = false;
            processBtn.textContent = "Process Study Material";
          }
        };
      }

      // 3. YouTube / Web URL Ingestion Handler
      const ingestUrlBtn = $("#btn-ingest-url");
      const urlInput = $("#input-material-url");
      const urlTypeSelect = $("#select-url-type");
      const urlTitleInput = $("#input-url-title");

      if (ingestUrlBtn && urlInput) {
        ingestUrlBtn.onclick = async () => {
          const rawUrl = (urlInput.value || "").trim();
          if (!rawUrl || !(rawUrl.startsWith("http://") || rawUrl.startsWith("https://"))) {
            showToast("Please enter a valid URL starting with http:// or https://", "warning");
            return;
          }

          ingestUrlBtn.disabled = true;
          ingestUrlBtn.textContent = "Ingesting URL Content...";

          const stages = [$("#stage-1"), $("#stage-2"), $("#stage-3"), $("#stage-4")];
          stages.forEach(s => s && (s.className = "stage-item running"));

          try {
            const sourceType = urlTypeSelect ? urlTypeSelect.value : "auto";
            const customTitle = urlTitleInput ? urlTitleInput.value.trim() : "";
            await ApiService.ingestMaterialUrl(rawUrl, sourceType, getCurrentUserId(), customTitle);

            stages.forEach(s => s && (s.className = "stage-item done"));
            showToast("URL material successfully parsed and indexed!", "success");
            await syncActiveDocument();
            setTimeout(() => {
              navigateTo("upload");
            }, 800);
          } catch (err) {
            stages.forEach(s => s && (s.className = "stage-item"));
            if (isMedicalVerificationRequired(err)) {
              _pendingVerificationUpload = {
                type: "url",
                url: rawUrl,
                sourceType: urlTypeSelect ? urlTypeSelect.value : "auto",
                customTitle: urlTitleInput ? urlTitleInput.value.trim() : "",
              };
              showToast("Medical student verification required for this clinical material.", "warning");
              openMedicalVerificationModal(err);
            } else {
              showToast(`Ingest URL error: ${err.message}`, "danger");
            }
            ingestUrlBtn.disabled = false;
            ingestUrlBtn.textContent = "Ingest URL Source";
          }
        };
      }

      // 4. Voice Note Recording Handler
      const recordMicBtn = $("#btn-record-mic");
      const voiceTimerEl = $("#voice-timer");
      const voiceStatusText = $("#voice-status-text");
      const voicePreviewAudio = $("#voice-preview-audio");
      const ingestVoiceBtn = $("#btn-ingest-voice");

      let mediaRecorder = null;
      let audioChunks = [];
      let timerInterval = null;
      let recordSeconds = 0;
      let recordedAudioBlob = null;

      if (recordMicBtn) {
        recordMicBtn.onclick = async () => {
          if (mediaRecorder && mediaRecorder.state === "recording") {
            // Stop recording
            mediaRecorder.stop();
            clearInterval(timerInterval);
            recordMicBtn.classList.remove("recording");
            if (voiceStatusText) voiceStatusText.textContent = "Recording stopped. Listen to preview or ingest below.";
            return;
          }

          // Start recording
          try {
            audioChunks = [];
            recordSeconds = 0;
            if (voiceTimerEl) voiceTimerEl.textContent = "00:00";
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);

            mediaRecorder.ondataavailable = e => {
              if (e.data.size > 0) audioChunks.push(e.data);
            };

            mediaRecorder.onstop = () => {
              recordedAudioBlob = new Blob(audioChunks, { type: "audio/webm" });
              if (voicePreviewAudio) {
                voicePreviewAudio.src = URL.createObjectURL(recordedAudioBlob);
                voicePreviewAudio.style.display = "block";
              }
              if (ingestVoiceBtn) ingestVoiceBtn.disabled = false;
              stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorder.start();
            recordMicBtn.classList.add("recording");
            if (voiceStatusText) voiceStatusText.textContent = "Recording spoken lecture... Click again to finish.";

            timerInterval = setInterval(() => {
              recordSeconds++;
              const mm = String(Math.floor(recordSeconds / 60)).padStart(2, "0");
              const ss = String(recordSeconds % 60).padStart(2, "0");
              if (voiceTimerEl) voiceTimerEl.textContent = `${mm}:${ss}`;
            }, 1000);
          } catch (err) {
            showToast(`Microphone access error: ${err.message}`, "danger");
          }
        };
      }

      if (ingestVoiceBtn) {
        ingestVoiceBtn.onclick = async () => {
          if (!recordedAudioBlob) return;
          ingestVoiceBtn.disabled = true;
          ingestVoiceBtn.textContent = "Transcribing & Ingesting...";

          const stages = [$("#stage-1"), $("#stage-2"), $("#stage-3"), $("#stage-4")];
          stages.forEach(s => s && (s.className = "stage-item running"));

          try {
            const fileName = `voice_note_${Date.now()}.webm`;
            const audioFile = new File([recordedAudioBlob], fileName, { type: "audio/webm" });
            await ApiService.ingestMaterialFile([audioFile], getCurrentUserId(), "Spoken Lecture Voice Note");

            stages.forEach(s => s && (s.className = "stage-item done"));
            showToast("Voice note transcribed & indexed successfully!", "success");
            await syncActiveDocument();
            setTimeout(() => {
              navigateTo("upload");
            }, 800);
          } catch (err) {
            stages.forEach(s => s && (s.className = "stage-item"));
            showToast(`Voice note ingestion error: ${err.message}`, "danger");
            ingestVoiceBtn.disabled = false;
            ingestVoiceBtn.textContent = "Transcribe & Ingest Spoken Note";
          }
        };
      }

      // 5. Sample 1-Click Loader
      if (sampleBtn) {
        sampleBtn.onclick = async () => {
          sampleBtn.disabled = true;
          sampleBtn.textContent = "Loading sample...";
          const stages = [$("#stage-1"), $("#stage-2"), $("#stage-3"), $("#stage-4")];
          stages.forEach(s => s && (s.className = "stage-item running"));

          try {
            await ApiService.loadSamplePdf();
            stages.forEach(s => s && (s.className = "stage-item done"));
            showToast("Sample 'Machine Learning Basics' loaded successfully!", "success");
            await syncActiveDocument();
            setTimeout(() => {
              navigateTo("upload");
            }, 800);
          } catch (e) {
            stages.forEach(s => s && (s.className = "stage-item"));
            showToast(`Could not load sample: ${e.message}`, "danger");
            sampleBtn.disabled = false;
            sampleBtn.textContent = "Try Sample: ML Basics";
          }
        };
      }

      // 6. Delete Material Action
      $$(".btn-delete-mat").forEach(btn => {
        btn.onclick = async e => {
          e.stopPropagation();
          const matId = btn.getAttribute("data-id");
          if (!matId) return;
          if (!confirm("Are you sure you want to remove this study material? The knowledge base and concept graph will be updated.")) {
            return;
          }
          btn.disabled = true;
          try {
            await ApiService.deleteMaterial(matId, getCurrentUserId());
            showToast("Material removed and knowledge base updated.", "success");
            await syncActiveDocument();
            navigateTo("upload");
          } catch (err) {
            showToast(`Delete failed: ${err.message}`, "danger");
            btn.disabled = false;
          }
        };
      });

      // 7. Interactive Preview Modal Action
      const previewModal = $("#material-preview-modal");
      const previewModalClose = $("#preview-modal-close");
      const previewModalTitle = $("#preview-modal-title");
      const previewModalBadge = $("#preview-modal-type-badge");
      const previewModalBody = $("#preview-modal-body");

      if (previewModalClose && previewModal) {
        previewModalClose.onclick = () => previewModal.close();
      }

      $$(".btn-preview-mat").forEach(btn => {
        btn.onclick = async () => {
          const matId = btn.getAttribute("data-id");
          if (!matId || !previewModal) return;

          btn.disabled = true;
          const origText = btn.innerHTML;
          btn.textContent = "Loading...";

          try {
            const preview = await ApiService.getMaterialPreview(matId);
            btn.disabled = false;
            btn.innerHTML = origText;

            if (previewModalTitle) previewModalTitle.textContent = preview.title || "Material Preview";
            if (previewModalBadge) {
              const stype = (preview.source_type || "pdf").toLowerCase();
              previewModalBadge.textContent = stype.toUpperCase();
              previewModalBadge.className = `material-type-badge badge-${stype}`;
            }

            // Render structured preview based on source type
            let bodyHtml = "";
            const stype = (preview.source_type || "").toLowerCase();
            const items = Array.isArray(preview.structured_preview) ? preview.structured_preview : [];

            if (stype === "youtube") {
              const videoId = items[0]?.video_id || "";
              bodyHtml = `
                <div class="youtube-split-viewer">
                  <div class="video-player-frame">
                    ${videoId ? `
                      <iframe id="youtube-player-iframe" src="https://www.youtube.com/embed/${esc(videoId)}?enablejsapi=1" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
                    ` : `
                      <div style="display:flex; align-items:center; justify-content:center; height:100%; color:#fff;">No video stream available</div>
                    `}
                  </div>
                  <div class="youtube-transcript-list" id="youtube-transcript-list">
                    <h4 style="margin:0 0 0.5rem 0; font-size:0.95rem; color:var(--ink-primary);">Timestamped Transcript (${items.length} segments across full duration)</h4>
                    ${items.map(it => {
                      const ts = it.label || it.timestamp || "00:00";
                      const sec = it.start_seconds !== undefined ? it.start_seconds : parseTimestampToSeconds(ts);
                      return `
                        <div class="transcript-row" data-seconds="${sec}" data-video-id="${esc(videoId)}">
                          <span class="transcript-ts-badge">[${esc(ts)}]</span>
                          <span>${esc(it.text)}</span>
                        </div>
                      `;
                    }).join('')}
                  </div>
                </div>
              `;
            } else if (stype === "web") {
              bodyHtml = `
                <div class="web-reader-container">
                  <div style="margin-bottom:1.25rem; font-size:0.85rem; color:var(--ink-muted);">
                    Source Article: <a href="${esc(preview.original_filename_or_url)}" target="_blank" rel="noopener" style="color:var(--primary); font-weight:600;">${esc(preview.original_filename_or_url)}</a>
                  </div>
                  ${items.map(it => `
                    <div style="margin-bottom:1.5rem;">
                      <h3 class="web-reader-heading">${esc(it.heading || it.label)}</h3>
                      <p style="white-space:pre-wrap; color:var(--ink-secondary); font-size:0.95rem;">${esc(it.text)}</p>
                    </div>
                  `).join('')}
                </div>
              `;
            } else if (stype === "audio") {
              bodyHtml = `
                <div class="preview-cards-list">
                  <div style="background:var(--surface-muted); padding:1rem; border-radius:var(--radius-md); margin-bottom:0.5rem;">
                    <h4 style="margin:0 0 0.25rem 0;">Audio Voice Note Transcript</h4>
                    <p style="margin:0; font-size:0.85rem; color:var(--ink-muted);">Speech recognized and segmented into timestamped topics.</p>
                  </div>
                  ${items.map(it => `
                    <div class="preview-card-item">
                      <div class="preview-card-header">
                        <span class="preview-locator-pill">${esc(it.label)}</span>
                        <span style="font-size:0.8rem; color:var(--ink-muted);">${esc(it.timestamp || '')}</span>
                      </div>
                      <div class="preview-card-text">${esc(it.text)}</div>
                    </div>
                  `).join('')}
                </div>
              `;
            } else {
              // PDF, PPTX, Markdown, DOCX
              const isDeepAudioSupported = (stype === "pdf" || stype === "pptx");
              const deepAudioBanner = isDeepAudioSupported ? `
                <div class="deep-audio-banner">
                  <div>
                    <strong style="color:var(--primary); font-size:0.92rem;">🎧 Professor Audio Deep-Dive</strong>
                    <p style="margin:0; font-size:0.8rem; color:var(--ink-muted);">Generate an in-depth spoken audio explanation with ElevenLabs Flash speech synthesis.</p>
                  </div>
                  <button class="btn btn-sm btn-primary btn-generate-deep-audio" data-mat-id="${esc(preview.material_id || matId)}" data-index="0">
                    🎧 Deeper Audio Explanation
                  </button>
                </div>
                <div id="modal-deep-audio-player-wrapper" style="display:none; margin-bottom:1rem; padding:0.75rem; background:var(--surface-muted); border-radius:var(--radius-md);"></div>
              ` : '';

              bodyHtml = `
                ${deepAudioBanner}
                <div class="preview-cards-list">
                  ${items.map((it, idx) => `
                    <div class="preview-card-item">
                      <div class="preview-card-header" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:0.5rem;">
                        <div style="display:flex; align-items:center; gap:0.5rem;">
                          <span class="preview-locator-pill">${esc(it.label)}</span>
                          ${it.title ? `<strong style="font-size:0.95rem; color:var(--ink-primary);">${esc(it.title)}</strong>` : ''}
                          ${it.heading ? `<strong style="font-size:0.95rem; color:var(--ink-primary);">${esc(it.heading)}</strong>` : ''}
                        </div>
                        ${isDeepAudioSupported ? `
                          <button class="btn btn-xs btn-outline btn-generate-deep-audio" data-mat-id="${esc(preview.material_id || matId)}" data-index="${it.index !== undefined ? it.index : idx}">
                            🎧 Deeper Audio Explanation
                          </button>
                        ` : ''}
                      </div>
                      <div class="preview-card-text">${esc(it.text)}</div>
                      ${it.notes ? `
                        <div class="preview-notes-box">
                          <strong>Speaker Notes:</strong> ${esc(it.notes)}
                        </div>
                      ` : ''}
                    </div>
                  `).join('')}
                </div>
              `;
            }

            if (previewModalBody) {
              previewModalBody.innerHTML = bodyHtml;

              // Bind Deeper Audio Explanation handlers if eligible
              if (stype === "pdf" || stype === "pptx") {
                const daBtns = previewModalBody.querySelectorAll(".btn-generate-deep-audio");
                daBtns.forEach(daBtn => {
                  daBtn.onclick = async () => {
                    const targetMatId = daBtn.getAttribute("data-mat-id") || matId;
                    const targetIndex = parseInt(daBtn.getAttribute("data-index") || "0", 10);
                    const origBtnText = daBtn.innerHTML;
                    daBtn.disabled = true;
                    daBtn.textContent = "Synthesizing deep audio...";

                    try {
                      const audioRes = await ApiService.generateDeepAudio(targetMatId, targetIndex, getCurrentUserId());
                      const audioUrl = ApiService.getArtifactUrl(audioRes.audio_url || audioRes.url || audioRes);
                      let playerWrap = $("#modal-deep-audio-player-wrapper", previewModalBody);
                      if (playerWrap) {
                        playerWrap.style.display = "block";
                        playerWrap.innerHTML = `
                          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.4rem;">
                            <span style="font-weight:600; font-size:0.84rem; color:var(--ink-primary);">🎧 Deep Spoken Explanation (Section/Slide ${targetIndex + 1})</span>
                            <a href="${esc(audioUrl)}" download class="btn btn-xs btn-outline">Save MP3</a>
                          </div>
                          <audio controls autoplay src="${esc(audioUrl)}" style="width:100%; height:36px;"></audio>
                        `;
                      }
                      showToast("Deep audio explanation generated!", "success");
                    } catch (audioErr) {
                      showToast(`Deep audio synthesis failed: ${audioErr.message}`, "danger");
                    } finally {
                      daBtn.disabled = false;
                      daBtn.innerHTML = origBtnText;
                    }
                  };
                });
              }
              if (stype === "youtube") {
                previewModalBody.querySelectorAll(".transcript-row").forEach(r => {
                  r.onclick = () => {
                    const sec = parseInt(r.getAttribute("data-seconds"), 10);
                    const vid = r.getAttribute("data-video-id");
                    if (!isNaN(sec)) {
                      window.jumpYouTubePlayerToSeconds(sec, vid);
                    }
                  };
                });
              }
            }

            previewModal.showModal();
          } catch (err) {
            btn.disabled = false;
            btn.innerHTML = origText;
            showToast(`Could not load preview: ${err.message}`, "danger");
          }
        };
      });
    },

    tutor() {
      const stream = $("#tutor-messages-stream");
      const form = $("#tutor-input-form");
      const input = $("#tutor-question-input");
      const clearBtn = $("#btn-clear-chat");

      // Math formatting on load
      renderMath(stream);

      // Delegate citation click
      if (stream) {
        stream.onclick = e => {
          const chip = e.target.closest(".view-citation-btn");
          if (chip) {
            openSourceModal({
              page: chip.getAttribute("data-page"),
              snippet: chip.getAttribute("data-snippet"),
              text: chip.getAttribute("data-text")
            });
          }
        };
      }

      // Suggestion chips click
      $$(".suggestion-chip").forEach(chip => {
        chip.onclick = () => {
          const prompt = chip.getAttribute("data-prompt");
          if (input && prompt) {
            input.value = prompt;
            form.dispatchEvent(new Event("submit"));
          }
        };
      });

      // Clear chat
      if (clearBtn) {
        clearBtn.onclick = () => {
          AppState.chatMessages = [
            {
              sender: "assistant",
              text: "Conversation cleared. Ask me anything about your study notes!",
              citations: []
            }
          ];
          stream.innerHTML = AppState.chatMessages.map(msg => renderChatMessage(msg)).join("");
        };
      }

      // Submit question
      if (form) {
        form.onsubmit = async e => {
          e.preventDefault();
          const question = input.value.trim();
          if (!question) return;
          input.value = "";

          // Append student message
          const userMsg = { sender: "user", text: esc(question) };
          AppState.chatMessages.push(userMsg);
          stream.insertAdjacentHTML("beforeend", renderChatMessage(userMsg));
          renderMath(stream);
          stream.scrollTop = stream.scrollHeight;

          // Placeholder thinking bubble
          const tempId = `thinking-${Date.now()}`;
          stream.insertAdjacentHTML("beforeend", `
            <div class="chat-row assistant" id="${tempId}">
              <div class="chat-avatar bot-avatar">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/></svg>
              </div>
              <div class="message-bubble" style="color:var(--ink-muted);">
                Analyzing material &amp; verifying citations...
              </div>
            </div>
          `);
          stream.scrollTop = stream.scrollHeight;

          try {
            const resp = await ApiService.askTutor(question);
            const thinkingEl = $(`#${tempId}`);
            if (thinkingEl) thinkingEl.remove();

            const tutorMsg = {
              sender: "assistant",
              text: esc(resp.answer),
              citations: resp.citations || [],
              artifacts: resp.artifacts || [],
              external_links: resp.external_links || []
            };
            AppState.chatMessages.push(tutorMsg);
            stream.insertAdjacentHTML("beforeend", renderChatMessage(tutorMsg));
            renderMath(stream);
            stream.scrollTop = stream.scrollHeight;
          } catch (err) {
            const thinkingEl = $(`#${tempId}`);
            if (thinkingEl) {
              thinkingEl.querySelector(".message-bubble").textContent = `Error: ${err.message}`;
            }
          }
        };
      }
    },

    activeRecall() {
      renderMath(document);
      const session = AppState.activeRecallSession;
      if (!session) return;

      // Clickable study citation pill jumps to video or source preview
      $$(".study-citation-pill").forEach(pill => {
        pill.style.cursor = "pointer";
        pill.onclick = () => {
          const txt = pill.textContent || "";
          const match = txt.match(/(\d{1,2}:\d{2})/);
          if (match) {
            const sec = parseTimestampToSeconds(match[1]);
            window.openVideoPreviewAtTimestamp(sec);
          }
        };
      });

      // Concept Selector
      const conceptSelect = $("#recall-concept-select");
      if (conceptSelect) {
        conceptSelect.onchange = async () => {
          if (session.timerInterval) {
            clearInterval(session.timerInterval);
            session.timerInterval = null;
          }
          session.conceptId = conceptSelect.value;
          session.stage = 1;
          session.card = null;
          session.recallText = "";
          session.verificationAnswer = "";
          session.evaluation = null;
          navigateTo("active-recall");
        };
      }

      // Stage 1: Timer Pills
      $$(".timer-pill-btn").forEach(btn => {
        btn.onclick = () => {
          $$(".timer-pill-btn").forEach(b => b.classList.remove("active"));
          btn.classList.add("active");
          const secs = parseInt(btn.getAttribute("data-seconds"), 10) || 180;
          session.timerSec = secs;
          session.timeLeft = secs;
          const startBtn = $("#btn-start-recall-timer");
          if (startBtn) {
            startBtn.innerHTML = `Start Learning Timer (${Math.round(secs/60)}m) &rarr;`;
          }
        };
      });

      // Stage 1: Start Timer
      const startTimerBtn = $("#btn-start-recall-timer");
      if (startTimerBtn) {
        startTimerBtn.onclick = () => {
          session.stage = 2;
          session.timeLeft = session.timerSec;
          navigateTo("active-recall");
        };
      }

      // Stage 2: Timer Countdown & "I'm Ready"
      if (session.stage === 2) {
        if (session.timerInterval) clearInterval(session.timerInterval);

        const ringCircle = $("#timer-ring-circle");
        const timerText = $("#timer-countdown-text");
        const circumference = 2 * Math.PI * 38;

        session.timerInterval = setInterval(() => {
          session.timeLeft--;
          if (session.timeLeft <= 0) {
            clearInterval(session.timerInterval);
            session.timerInterval = null;
            session.stage = 3;
            navigateTo("active-recall");
            return;
          }
          if (timerText) {
            const m = Math.floor(session.timeLeft / 60);
            const s = session.timeLeft % 60;
            timerText.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
          }
          if (ringCircle) {
            const ratio = session.timeLeft / session.timerSec;
            ringCircle.style.strokeDashoffset = circumference * (1 - ratio);
          }
        }, 1000);

        const readyBtn = $("#btn-ready-test-now");
        if (readyBtn) {
          readyBtn.onclick = () => {
            if (session.timerInterval) {
              clearInterval(session.timerInterval);
              session.timerInterval = null;
            }
            session.stage = 3;
            navigateTo("active-recall");
          };
        }
      }

      // Stage 3: Blind Retrieval Input & Submit
      if (session.stage === 3) {
        const recallTextarea = $("#active-recall-text");
        const statsDisplay = $("#recall-stats-display");
        const submitBtn = $("#btn-submit-active-recall");
        const verifInput = $("#verification-answer-input");

        if (recallTextarea) {
          recallTextarea.focus();
          recallTextarea.addEventListener("input", () => {
            const val = recallTextarea.value;
            session.recallText = val;
            const words = val.trim() ? val.trim().split(/\s+/).length : 0;
            const chars = val.length;
            if (statsDisplay) {
              statsDisplay.textContent = `${words} word${words === 1 ? '' : 's'} · ${chars} character${chars === 1 ? '' : 's'}`;
            }
            if (submitBtn) {
              submitBtn.disabled = (val.trim().length < 15);
            }
          });
        }

        if (verifInput) {
          verifInput.addEventListener("input", () => {
            session.verificationAnswer = verifInput.value;
          });
        }

        if (submitBtn) {
          submitBtn.onclick = async () => {
            submitBtn.disabled = true;
            submitBtn.innerHTML = "Evaluating Retrieval...";
            const duration = session.timerSec - session.timeLeft;
            try {
              const evalRes = await ApiService.evaluateActiveRecall(
                session.conceptId,
                session.recallText,
                session.verificationAnswer,
                duration,
                getCurrentUserId(),
                (session.card && session.card.session_id) || ""
              );
              session.evaluation = evalRes;
              session.stage = 4;
              navigateTo("active-recall");
            } catch (evalErr) {
              showToast(`Evaluation failed: ${evalErr.message}`, "danger");
              submitBtn.disabled = false;
              submitBtn.innerHTML = "Submit Active Recall &rarr;";
            }
          };
        }
      }

      // Stage 4: Retry / Continue Actions
      if (session.stage === 4) {
        const retryBtn = $("#btn-recall-retry");
        const continueBtn = $("#btn-recall-continue");

        if (retryBtn) {
          retryBtn.onclick = () => {
            session.stage = 1;
            session.recallText = "";
            session.verificationAnswer = "";
            session.evaluation = null;
            navigateTo("active-recall");
          };
        }

        if (continueBtn) {
          continueBtn.onclick = () => {
            const concepts = AppState.masteryList || [];
            const curIdx = concepts.findIndex(c => c.id === session.conceptId);
            const nextIdx = (curIdx + 1) % Math.max(concepts.length, 1);
            session.conceptId = concepts[nextIdx] ? concepts[nextIdx].id : session.conceptId;
            session.stage = 1;
            session.card = null;
            session.recallText = "";
            session.verificationAnswer = "";
            session.evaluation = null;
            navigateTo("active-recall");
          };
        }

        $$(".start-target-quiz").forEach(btn => {
          btn.onclick = () => {
            AppState.quizSession.targetConceptId = btn.getAttribute("data-target-concept");
          };
        });
      }
    },

    smartNotes() {
      renderMath(document);

      // 1. Pre-Generation Task Selector interaction
      const taskCards = $$(".task-card");
      const customPromptBox = $("#custom-prompt-box");
      const errorMsg = $("#task-selector-error");
      const customInput = $("#custom-instructions-input");
      const conceptSelect = $("#smart-notes-concept-select");
      const generateBtn = $("#btn-generate-smart-notes");

      taskCards.forEach(card => {
        card.onclick = () => {
          const task = card.getAttribute("data-task");
          AppState.smartNotes.selectedTask = task;

          taskCards.forEach(c => c.classList.remove("selected"));
          card.classList.add("selected");

          if (errorMsg) errorMsg.classList.remove("visible");

          if (customPromptBox) {
            if (task === "custom") {
              customPromptBox.classList.add("visible");
            } else {
              customPromptBox.classList.remove("visible");
            }
          }
        };
      });

      if (customInput) {
        customInput.oninput = () => {
          AppState.smartNotes.customInstructions = customInput.value;
        };
      }

      if (conceptSelect) {
        conceptSelect.onchange = () => {
          AppState.smartNotes.selectedConceptId = conceptSelect.value;
        };
      }

      // 2. Generate Smart Notes Button Click
      if (generateBtn) {
        generateBtn.onclick = async () => {
          // MANDATORY GATE: Task type must be selected
          if (!AppState.smartNotes.selectedTask) {
            if (errorMsg) errorMsg.classList.add("visible");
            showToast("Please select your task type before generating notes.", "warning");
            const grid = $("#task-selector-grid");
            if (grid) grid.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
          }

          const conceptId = (conceptSelect && conceptSelect.value) || AppState.smartNotes.selectedConceptId || "recursion";
          const taskType = AppState.smartNotes.selectedTask;
          const customInstructions = (customInput && customInput.value.trim()) || AppState.smartNotes.customInstructions || "";
          const userId = getCurrentUserId();

          generateBtn.disabled = true;
          const origText = generateBtn.innerHTML;
          generateBtn.innerHTML = `
            <span class="upload-icon-pulse" style="width:16px; height:16px; border:2px solid #fff; border-top-color:transparent; border-radius:50%; display:inline-block; animation:spin 1s linear infinite;"></span>
            <span>Synthesizing ${taskType.toUpperCase()} Notes...</span>
          `;

          try {
            const noteRes = await ApiService.generateNote({
              concept_id: conceptId,
              task_type: taskType,
              custom_instructions: customInstructions || undefined,
              user_id: userId
            });

            AppState.smartNotes.activeNote = noteRes;
            AppState.smartNotes.diagramSvg = null;
            AppState.smartNotes.activeAudioUrl = noteRes.audio_url || null;

            showToast(`Generated ${taskType.toUpperCase()} notes for ${conceptId.replace(/_/g, ' ')}!`, "success");
            await navigateTo("smart-notes");

            // Scroll to active note view
            const activeNoteView = $("#active-note-view");
            if (activeNoteView) {
              activeNoteView.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          } catch (err) {
            showToast(`Note generation failed: ${err.message}`, "danger");
          } finally {
            generateBtn.disabled = false;
            generateBtn.innerHTML = origText;
          }
        };
      }

      // 3. Note Action Bar Buttons (Active Note)
      const activeNote = AppState.smartNotes.activeNote;
      if (activeNote) {
        // A. Listen to Audio Note (ElevenLabs Flash)
        const audioBtn = $("#btn-note-audio");
        const playerBox = $("#note-audio-player-box");
        const audioElement = $("#note-audio-element");

        if (audioBtn) {
          audioBtn.onclick = async () => {
            audioBtn.disabled = true;
            const origAudioText = audioBtn.innerHTML;
            audioBtn.innerHTML = "🎧 Synthesizing Flash Audio...";

            try {
              const res = await ApiService.generateNoteAudio(activeNote.note_id, getCurrentUserId());
              const audioUrl = ApiService.getArtifactUrl(res.audio_url || (activeNote.note_id ? `/api/artifacts/audio_${activeNote.note_id}.mp3` : ""));
              AppState.smartNotes.activeAudioUrl = audioUrl;

              if (playerBox) playerBox.classList.add("visible");
              if (audioElement) {
                audioElement.src = audioUrl;
                audioElement.play().catch(() => {});
              }
              showToast("ElevenLabs audio summary ready!", "success");
              audioBtn.innerHTML = "🎧 Audio Ready";
            } catch (err) {
              showToast(`Audio generation failed: ${err.message}`, "danger");
              audioBtn.innerHTML = origAudioText;
            } finally {
              audioBtn.disabled = false;
            }
          };
        }

        // B. Download PDF
        const pdfBtn = $("#btn-note-pdf");
        if (pdfBtn) {
          pdfBtn.onclick = async () => {
            pdfBtn.disabled = true;
            const origPdfText = pdfBtn.innerHTML;
            pdfBtn.innerHTML = "📄 Building PDF...";

            try {
              const res = await ApiService.exportNoteArtifact(activeNote.note_id, "pdf", getCurrentUserId());
              const pdfUrl = ApiService.getArtifactUrl(res.pdf_url || res.url || res.download_url || "");
              triggerBrowserDownload(pdfUrl, `Note_${activeNote.concept_id}_${activeNote.note_id}.pdf`);
              showToast("PDF handout downloaded!", "success");
            } catch (err) {
              showToast(`PDF export failed: ${err.message}`, "danger");
            } finally {
              pdfBtn.disabled = false;
              pdfBtn.innerHTML = origPdfText;
            }
          };
        }

        // C. Export PPTX
        const pptxBtn = $("#btn-note-pptx");
        if (pptxBtn) {
          pptxBtn.onclick = async () => {
            pptxBtn.disabled = true;
            const origPptxText = pptxBtn.innerHTML;
            pptxBtn.innerHTML = "📊 Building Deck...";

            try {
              const res = await ApiService.exportNoteArtifact(activeNote.note_id, "pptx", getCurrentUserId());
              const pptxUrl = ApiService.getArtifactUrl(res.pptx_url || res.url || res.download_url || "");
              triggerBrowserDownload(pptxUrl, `Deck_${activeNote.concept_id}_${activeNote.note_id}.pptx`);
              showToast("PPTX slide deck downloaded!", "success");
            } catch (err) {
              showToast(`PPTX export failed: ${err.message}`, "danger");
            } finally {
              pptxBtn.disabled = false;
              pptxBtn.innerHTML = origPptxText;
            }
          };
        }

        // D. Generate Diagram
        const diagramBtn = $("#btn-note-diagram");
        const diagramBox = $("#note-diagram-box");
        const diagramInner = $("#note-diagram-inner");

        if (diagramBtn) {
          diagramBtn.onclick = async () => {
            diagramBtn.disabled = true;
            const origDiagText = diagramBtn.innerHTML;
            diagramBtn.innerHTML = "🖼️ Rendering Diagram...";

            try {
              const res = await ApiService.generateToolArtifact("visual", activeNote.concept_id, "", 5, getCurrentUserId());
              const svgContent = res.svg || res.code || (res.download_url ? `<img src="${esc(ApiService.getArtifactUrl(res.download_url))}" style="max-width:100%;" />` : "");
              AppState.smartNotes.diagramSvg = svgContent;

              if (diagramBox) diagramBox.style.display = "block";
              if (diagramInner) diagramInner.innerHTML = svgContent;
              showToast("SVG Architecture diagram embedded!", "success");
            } catch (err) {
              showToast(`Diagram generation failed: ${err.message}`, "danger");
            } finally {
              diagramBtn.disabled = false;
              diagramBtn.innerHTML = origDiagText;
            }
          };
        }

        // Clickable citation chips inside note
        $$(".grounded-citation-chip", $("#active-note-view") || document).forEach(chip => {
          chip.onclick = () => {
            const loc = chip.getAttribute("data-loc") || "1";
            openSourceModal({
              page: loc,
              snippet: activeNote.concept_id.replace(/_/g, ' ').toUpperCase(),
              text: `Grounded citation reference for ${activeNote.concept_id} verified from primary source at ${loc}.`
            });
          };
        });
      }

      // 4. Saved Notes Archive Actions
      $$(".btn-read-saved-note").forEach(btn => {
        btn.onclick = () => {
          const noteId = btn.getAttribute("data-id");
          const note = (AppState.smartNotes.savedNotes || []).find(n => n.note_id === noteId);
          if (note) {
            AppState.smartNotes.activeNote = note;
            AppState.smartNotes.selectedTask = note.task_type || "exam";
            AppState.smartNotes.selectedConceptId = note.concept_id;
            AppState.smartNotes.diagramSvg = null;
            AppState.smartNotes.activeAudioUrl = note.audio_url || null;
            navigateTo("smart-notes").then(() => {
              const el = $("#active-note-view");
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          }
        };
      });

      $$(".btn-audio-saved-note").forEach(btn => {
        btn.onclick = async () => {
          const noteId = btn.getAttribute("data-id");
          const existingUrl = btn.getAttribute("data-url");
          if (existingUrl) {
            const url = ApiService.getArtifactUrl(existingUrl);
            const playerBox = $("#note-audio-player-box");
            const audioElement = $("#note-audio-element");
            if (playerBox) playerBox.classList.add("visible");
            if (audioElement) {
              audioElement.src = url;
              audioElement.play().catch(() => {});
            }
            showToast("Playing saved audio executive summary!", "info");
          } else {
            btn.disabled = true;
            btn.textContent = "Synthesizing...";
            try {
              const res = await ApiService.generateNoteAudio(noteId, getCurrentUserId());
              const url = ApiService.getArtifactUrl(res.audio_url || "");
              btn.setAttribute("data-url", url);
              const playerBox = $("#note-audio-player-box");
              const audioElement = $("#note-audio-element");
              if (playerBox) playerBox.classList.add("visible");
              if (audioElement) {
                audioElement.src = url;
                audioElement.play().catch(() => {});
              }
              showToast("ElevenLabs audio summary ready!", "success");
            } catch (err) {
              showToast(`Audio synthesis failed: ${err.message}`, "danger");
            } finally {
              btn.disabled = false;
              btn.textContent = "🎧 Audio";
            }
          }
        };
      });

      $$(".btn-pdf-saved-note").forEach(btn => {
        btn.onclick = async () => {
          const noteId = btn.getAttribute("data-id");
          const existingUrl = btn.getAttribute("data-url");
          if (existingUrl) {
            triggerBrowserDownload(ApiService.getArtifactUrl(existingUrl), `Note_${noteId}.pdf`);
          } else {
            btn.disabled = true;
            btn.textContent = "Exporting...";
            try {
              const res = await ApiService.exportNoteArtifact(noteId, "pdf", getCurrentUserId());
              const url = ApiService.getArtifactUrl(res.pdf_url || res.url || "");
              btn.setAttribute("data-url", url);
              triggerBrowserDownload(url, `Note_${noteId}.pdf`);
              showToast("PDF handout downloaded!", "success");
            } catch (err) {
              showToast(`PDF export failed: ${err.message}`, "danger");
            } finally {
              btn.disabled = false;
              btn.textContent = "📄 PDF";
            }
          }
        };
      });

      $$(".btn-pptx-saved-note").forEach(btn => {
        btn.onclick = async () => {
          const noteId = btn.getAttribute("data-id");
          const existingUrl = btn.getAttribute("data-url");
          if (existingUrl) {
            triggerBrowserDownload(ApiService.getArtifactUrl(existingUrl), `Deck_${noteId}.pptx`);
          } else {
            btn.disabled = true;
            btn.textContent = "Exporting...";
            try {
              const res = await ApiService.exportNoteArtifact(noteId, "pptx", getCurrentUserId());
              const url = ApiService.getArtifactUrl(res.pptx_url || res.url || "");
              btn.setAttribute("data-url", url);
              triggerBrowserDownload(url, `Deck_${noteId}.pptx`);
              showToast("PPTX deck downloaded!", "success");
            } catch (err) {
              showToast(`PPTX export failed: ${err.message}`, "danger");
            } finally {
              btn.disabled = false;
              btn.textContent = "📊 PPTX";
            }
          }
        };
      });

      $$(".btn-delete-saved-note").forEach(btn => {
        btn.onclick = async () => {
          const noteId = btn.getAttribute("data-id");
          if (!confirm("Are you sure you want to delete this smart study note?")) return;
          try {
            await ApiService.deleteNote(noteId, getCurrentUserId());
            showToast("Smart note deleted.", "info");
            if (AppState.smartNotes.activeNote && AppState.smartNotes.activeNote.note_id === noteId) {
              AppState.smartNotes.activeNote = null;
            }
            navigateTo("smart-notes");
          } catch (err) {
            showToast(`Delete failed: ${err.message}`, "danger");
          }
        };
      });
    },

    practice() {
      const targetId = AppState.quizSession.targetConceptId;
      startNewQuizSession(targetId);

      const topicSelect = $("#practice-topic-select");
      if (topicSelect) {
        topicSelect.value = targetId || AppState.quizSession.currentConceptId || "";
        topicSelect.onchange = () => {
          const selectedCid = topicSelect.value || null;
          startNewQuizSession(selectedCid);
        };
      }
    },

    learningPath() {
      const toggleBtn = $("#toggle-graph-view");
      const graphContainer = $("#full-graph-container");
      if (toggleBtn && graphContainer) {
        toggleBtn.onclick = () => {
          const isHidden = graphContainer.style.display === "none";
          graphContainer.style.display = isHidden ? "block" : "none";
          toggleBtn.textContent = isHidden ? "Hide Topological Graph" : "Toggle Topological Graph";
        };
      }

      $$(".start-target-quiz").forEach(btn => {
        btn.onclick = () => {
          AppState.quizSession.targetConceptId = btn.getAttribute("data-target-concept");
        };
      });

      function showConceptActionModal(cid) {
        if (!cid) return;
        const modal = $("#concept-modal");
        const title = $("#concept-modal-title");
        const body = $("#concept-modal-body");
        if (!modal || !title || !body) return;

        const c = (AppState.masteryList || []).find(x => x.id === cid || x.concept_id === cid) ||
                  (AppState.graphData?.nodes || []).find(x => x.id === cid || x.concept_id === cid) ||
                  { id: cid, name: cid.replace(/[-_]/g, " ").replace(/\b\w/g, l => l.toUpperCase()), why: "Prerequisite Concept" };

        title.textContent = c.name || "Concept Details";
        const st = getConceptStatus(c);
        const scoreVal = (c.score !== undefined) ? Math.round((c.score || 0.5) * 100) : 50;

        body.innerHTML = `
          <div style="margin-bottom:1rem; display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
            <span class="status-pill ${st}">${st.toUpperCase()}</span>
            <span style="font-size:0.85rem; color:var(--ink-muted);">Estimated Belief: ${scoreVal}%</span>
          </div>
          <p style="margin-bottom:1rem; font-size:0.92rem; color:var(--ink-primary); line-height:1.5;">
            ${esc(c.definition || c.why || "Key concept extracted across the course material timeline.")}
          </p>
          ${c.prerequisites && c.prerequisites.length ? `
            <div style="margin-bottom:1rem;">
              <strong style="font-size:0.82rem; color:var(--ink-muted); text-transform:uppercase;">Prerequisites:</strong>
              <div style="display:flex; gap:0.35rem; flex-wrap:wrap; margin-top:0.25rem;">
                ${c.prerequisites.map(p => `<span class="badge" style="font-size:0.75rem; background:var(--surface-muted);">${esc(p)}</span>`).join('')}
              </div>
            </div>
          ` : ''}
          <div style="display:flex; gap:0.5rem; margin-top:1.5rem; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm start-direct-quiz" data-cid="${esc(c.id)}">⚡ Practice Quiz</button>
            <button class="btn btn-secondary btn-sm start-direct-recall" data-cid="${esc(c.id)}" data-name="${esc(c.name)}">🧠 Active Recall</button>
            <button class="btn btn-secondary btn-sm ask-direct-tutor" data-name="${esc(c.name)}">💬 Ask Tutor</button>
          </div>
        `;

        body.querySelector(".start-direct-quiz")?.addEventListener("click", () => {
          modal.close();
          AppState.quizSession.targetConceptId = c.id;
          navigateTo("practice");
        });

        body.querySelector(".start-direct-recall")?.addEventListener("click", () => {
          modal.close();
          if (!AppState.activeRecallSession) AppState.activeRecallSession = {};
          AppState.activeRecallSession.targetConceptId = c.id;
          AppState.activeRecallSession.targetConceptName = c.name;
          navigateTo("recall");
        });

        body.querySelector(".ask-direct-tutor")?.addEventListener("click", () => {
          modal.close();
          navigateTo("tutor");
          setTimeout(() => {
            const input = document.getElementById("tutor-prompt-input");
            if (input) {
              input.value = `Can you explain ${c.name} in detail and test my understanding?`;
              input.focus();
            }
          }, 300);
        });

        if (typeof modal.showModal === "function") modal.showModal();
        else modal.setAttribute("open", "");
      }

      // Non-Linear DAG Node Click Handler
      $$(".graph-node-group").forEach(nodeGroup => {
        nodeGroup.onclick = () => {
          const cid = nodeGroup.getAttribute("data-cid");
          if (cid) showConceptActionModal(cid);
        };
      });

      // Concept Details Modal
      $$(".inspect-concept-btn").forEach(btn => {
        btn.onclick = () => {
          const cid = btn.getAttribute("data-cid");
          if (cid) showConceptActionModal(cid);
        };
      });
    },

    progress() {
      renderMath(document);
      $$(".start-target-quiz").forEach(btn => {
        btn.onclick = () => {
          AppState.quizSession.targetConceptId = btn.getAttribute("data-target-concept");
        };
      });
    },

    settings() {
      const nameInput = $("#setting-student-name");
      const baseInput = $("#setting-backend-base");
      const mockCheck = $("#setting-mock-mode");
      const saveBtn = $("#btn-save-settings");
      const pingBtn = $("#btn-ping-backend");
      const resetBtn = $("#btn-reset-mastery");
      const diagOut = $("#settings-diag-output");

      // Theme selector buttons
      $$(".theme-select-btn").forEach(btn => {
        btn.onclick = () => {
          const t = btn.getAttribute("data-set-theme");
          applyTheme(t);
        };
      });

      if (saveBtn) {
        saveBtn.onclick = () => {
          if (nameInput) {
            const newName = nameInput.value.trim() || "Alex";
            AppState.studentName = newName;
            localStorage.setItem("cm_student_name", newName);
            const topName = $("#topbar-user-name");
            const topAvatar = $("#topbar-user-avatar");
            if (topName) topName.textContent = newName;
            if (topAvatar) topAvatar.textContent = newName[0] || "A";
          }
          if (baseInput && mockCheck) {
            ApiService.saveConfig({
              base: baseInput.value.trim().replace(/\/$/, ""),
              mock: mockCheck.checked
            });
          }
          showToast("Settings successfully saved!", "success");
        };
      }

      if (pingBtn && diagOut) {
        pingBtn.onclick = async () => {
          diagOut.textContent = "Pinging health endpoint...";
          try {
            const start = performance.now();
            const res = await ApiService.getHealth();
            const latency = Math.round(performance.now() - start);
            diagOut.textContent = `Server responded in ${latency}ms: ${JSON.stringify(res)}`;
          } catch (e) {
            diagOut.textContent = `Ping failed: ${e.message}`;
          }
        };
      }

      if (resetBtn) {
        resetBtn.onclick = async () => {
          if (!confirm("Are you sure you want to reset mastery belief history? This cannot be undone.")) return;
          try {
            await ApiService.resetMastery();
            showToast("Mastery history reset.", "info");
            setTimeout(() => { location.hash = "#dashboard"; }, 600);
          } catch (e) {
            showToast(`Reset failed: ${e.message}`, "danger");
          }
        };
      }
    }
  };

  // =========================================================================
  // QUIZ ENGINE CONTROLLER (Authoritative Server Evaluation)
  // =========================================================================

  function startNewQuizSession(conceptId = null) {
    AppState.quizSession.active = true;
    AppState.quizSession.currentConceptId = conceptId || null;
    AppState.quizSession.targetConceptId = null;
    AppState.quizSession.currentQuestion = null;
    AppState.quizSession.currentIndex = 1;
    AppState.quizSession.totalQuestions = 6;
    AppState.quizSession.score = 0;
    AppState.quizSession.history = [];

    // Reset session donut & stats
    updateQuizDonut();

    // Load first question for the fresh session
    loadQuizQuestion(conceptId);
  }

  async function loadQuizQuestion(conceptId = null) {
    const box = $("#quiz-card-box");
    if (!box) return;

    const targetCid = conceptId !== undefined && conceptId !== null ? conceptId : (AppState.quizSession.currentConceptId || null);

    box.innerHTML = `
      <div style="padding:2.5rem; text-align:center;">
        <div class="upload-icon-pulse" style="width:40px; height:40px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        <p style="margin-top:0.75rem;">Generating adaptive assessment item...</p>
      </div>
    `;

    try {
      let q = null;
      if (AppState.quizSession.remedialMode) {
        AppState.quizSession.remedialMode = false;
        try {
          const remRes = await ApiService.getRemedialQuiz(targetCid, getCurrentUserId());
          if (remRes && remRes.question) {
            q = remRes.question;
            if (remRes.concept_name) q.conceptName = remRes.concept_name;
          }
        } catch (remErr) {
          console.warn("Remedial quiz routing fallback:", remErr);
        }
      }

      if (!q) {
        q = await ApiService.getNextQuestion(targetCid);
      }

      if (!AppState.quizSession.seenQuestionIds) {
        AppState.quizSession.seenQuestionIds = new Set();
      }

      // Fresh question deduplication
      if (AppState.quizSession.seenQuestionIds.has(q.id)) {
        try {
          const fresh = await ApiService.getNextQuestion(targetCid);
          if (fresh && fresh.id !== q.id) q = fresh;
        } catch (_) {}
      }
      AppState.quizSession.seenQuestionIds.add(q.id);

      AppState.quizSession.currentQuestion = q;
      renderActiveQuestion(q);
    } catch (err) {
      box.innerHTML = `
        <div style="padding:2rem; text-align:center;">
          <h3 style="margin-bottom:0.5rem;">Could not load question</h3>
          <p style="color:var(--ink-secondary); margin-bottom:1.5rem;">${esc(err.message)}</p>
          <a href="#upload" class="btn btn-primary">Go to Study Material &rarr;</a>
        </div>
      `;
    }
  }

  function renderActiveQuestion(q) {
    const box = $("#quiz-card-box");
    if (!box) return;

    const letters = ["A", "B", "C", "D"];
    const completedCount = AppState.quizSession.history.length;
    const totalQuestions = AppState.quizSession.totalQuestions || 6;
    const progressPercent = Math.round((completedCount / totalQuestions) * 100);
    const qType = (q.questionType || q.question_type || (q.options && q.options.length ? "mcq" : "typed_qa")).toLowerCase();

    let typeBadgeLabel = "Multiple Choice";
    let typeBadgeClass = "mcq";
    if (qType === "fill_in_the_blanks") {
      typeBadgeLabel = "Fill in the Blank";
      typeBadgeClass = "fitb";
    } else if (qType === "typed_qa") {
      typeBadgeLabel = "Open-Ended Q&A";
      typeBadgeClass = "typed_qa";
    } else if (qType === "numerical") {
      typeBadgeLabel = "Numerical Calculation";
      typeBadgeClass = "numerical";
    }

    // Dynamic input area based on question type
    let inputHtml = "";
    if (qType === "fill_in_the_blanks") {
      const sentenceText = q.question || "";
      const hasBlank = sentenceText.includes("_____") || sentenceText.includes("___");
      inputHtml = `
        <div class="fitb-input-container">
          <div class="fitb-sentence-box">
            ${hasBlank 
              ? esc(sentenceText).replace(/_{3,}/g, `<input type="text" id="fitb-user-input" class="fitb-blank-input" placeholder="type term..." autocomplete="off" />`)
              : `<p style="margin-bottom:0.75rem;">${esc(sentenceText)}</p><input type="text" id="fitb-user-input" class="fitb-blank-input" placeholder="Type missing keyword..." autocomplete="off" style="width:100%; max-width:320px;" />`
            }
          </div>
          <div class="qa-helper-bar">
            <span>Type the exact term or concept keyword that completes the statement.</span>
          </div>
        </div>
      `;
    } else if (qType === "typed_qa") {
      inputHtml = `
        <div class="typed-qa-container">
          <textarea id="typed-qa-user-input" class="quiz-textarea" rows="4" placeholder="Explain the principle, mechanism, or relationship in your own words..."></textarea>
          <div class="qa-helper-bar">
            <span>AI Mastery Judge evaluates your conceptual explanation and depth.</span>
            <span id="qa-char-count">0 characters</span>
          </div>
        </div>
      `;
    } else if (qType === "numerical") {
      const givenParams = q.givenParameters || q.given_parameters || {};
      const formulaHint = q.formulaHint || q.formula_hint || "";
      const unitOrFormat = q.unitOrFormat || q.unit_or_format || "Round to 2 decimal places";
      inputHtml = `
        <div class="numerical-container">
          ${Object.keys(givenParams).length > 0 ? `
            <div class="numerical-params-grid">
              ${Object.entries(givenParams).map(([k, v]) => `
                <div class="numerical-param-pill">
                  <span class="param-key">${esc(k)}</span>
                  <span class="param-val">${esc(v)}</span>
                </div>
              `).join("")}
            </div>
          ` : ''}

          ${formulaHint ? `
            <div class="formula-hint-container">
              <button type="button" class="formula-hint-toggle" id="btn-toggle-formula-hint">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span>Show Formula Hint</span>
              </button>
              <div class="formula-hint-content" id="formula-hint-box" style="display:none;">
                ${formulaHint.includes("$") ? formulaHint : `$$${formulaHint}$$`}
              </div>
            </div>
          ` : ''}

          <div class="numerical-input-group">
            <label for="numerical-input">Enter Calculated Value:</label>
            <div class="numerical-input-row">
              <input type="number" step="any" id="numerical-input" class="numerical-input" placeholder="0.00" autocomplete="off" />
              <span class="numerical-unit-tag">${esc(unitOrFormat)}</span>
            </div>
          </div>

          <div class="scratchpad-wrap">
            <div class="scratchpad-toggle" id="btn-toggle-scratchpad">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              <span>Scratchpad / Working Steps (optional)</span>
            </div>
            <textarea id="numerical-scratchpad" class="scratchpad-textarea" rows="2" placeholder="Working steps or notes..."></textarea>
          </div>
        </div>
      `;
    } else {
      // Standard MCQ
      const options = q.options || [];
      inputHtml = `
        <div class="quiz-options-group" id="quiz-options-group">
          ${options.map((opt, i) => `
            <button class="quiz-opt-btn" data-index="${i}">
              <span class="opt-letter-badge">${letters[i] || (i + 1)}</span>
              <span class="opt-text">${esc(opt)}</span>
            </button>
          `).join("")}
        </div>
      `;
    }

    box.innerHTML = `
      <div class="quiz-progress-header">
        <div style="display:flex; align-items:center; gap:0.6rem;">
          <span class="status-pill unknown">${esc(q.conceptName || q.conceptId)}</span>
          <span class="badge-question-type ${typeBadgeClass}">${typeBadgeLabel}</span>
        </div>
        <div style="display:flex; align-items:center; gap:0.75rem;">
          <span style="font-size:0.82rem; font-weight:600; color:var(--ink-muted);">
            Question ${AppState.quizSession.currentIndex} of ${totalQuestions} (${completedCount}/${totalQuestions} completed)
          </span>
          <div style="width:110px;" class="progress-bar-track" title="${completedCount} of ${totalQuestions} questions completed">
            <div class="progress-bar-fill" style="width:${progressPercent}%;"></div>
          </div>
        </div>
      </div>

      <h3 class="question-prompt" id="question-prompt-text">${esc(q.question)}</h3>

      ${inputHtml}

      <div id="quiz-feedback-container"></div>

      <div class="quiz-actions-bar">
        <button class="btn btn-secondary btn-sm" id="btn-quiz-skip">Skip Question</button>
        <button class="btn btn-primary" id="btn-quiz-submit" disabled>Submit Answer</button>
      </div>
    `;

    renderMath(box);

    let selectedIdx = null;
    const submitBtn = $("#btn-quiz-submit");
    const skipBtn = $("#btn-quiz-skip");
    const fitbInput = $("#fitb-user-input");
    const typedQaInput = $("#typed-qa-user-input");
    const numericalInput = $("#numerical-input");
    const formulaToggleBtn = $("#btn-toggle-formula-hint");
    const formulaBox = $("#formula-hint-box");
    const scratchpadToggleBtn = $("#btn-toggle-scratchpad");
    const scratchpadArea = $("#numerical-scratchpad");
    const optionBtns = box.querySelectorAll(".quiz-opt-btn");

    // Toggle listeners for formula hint and scratchpad
    if (formulaToggleBtn && formulaBox) {
      formulaToggleBtn.onclick = () => {
        const isHidden = (formulaBox.style.display === "none");
        formulaBox.style.display = isHidden ? "block" : "none";
        formulaToggleBtn.querySelector("span").textContent = isHidden ? "Hide Formula Hint" : "Show Formula Hint";
        if (isHidden) renderMath(formulaBox);
      };
    }

    if (scratchpadToggleBtn && scratchpadArea) {
      scratchpadToggleBtn.onclick = () => {
        scratchpadArea.style.display = (scratchpadArea.style.display === "none") ? "block" : "none";
      };
    }

    // Input listeners per type
    if (qType === "fill_in_the_blanks" && fitbInput) {
      fitbInput.focus();
      fitbInput.addEventListener("input", () => {
        submitBtn.disabled = !fitbInput.value.trim();
      });
      fitbInput.addEventListener("keydown", e => {
        if (e.key === "Enter" && !submitBtn.disabled) {
          submitBtn.click();
        }
      });
    } else if (qType === "typed_qa" && typedQaInput) {
      typedQaInput.focus();
      const countEl = $("#qa-char-count");
      typedQaInput.addEventListener("input", () => {
        const len = typedQaInput.value.trim().length;
        if (countEl) countEl.textContent = `${len} character${len === 1 ? '' : 's'}`;
        submitBtn.disabled = (len < 4);
      });
    } else if (qType === "numerical" && numericalInput) {
      numericalInput.focus();
      numericalInput.addEventListener("input", () => {
        submitBtn.disabled = !numericalInput.value.trim();
      });
      numericalInput.addEventListener("keydown", e => {
        if (e.key === "Enter" && !submitBtn.disabled) {
          submitBtn.click();
        }
      });
    } else {
      // MCQ
      optionBtns.forEach(btn => {
        btn.onclick = () => {
          optionBtns.forEach(b => b.classList.remove("selected"));
          btn.classList.add("selected");
          selectedIdx = parseInt(btn.getAttribute("data-index"), 10);
          submitBtn.disabled = false;
        };
      });

      const handleKeyNav = e => {
        if (AppState.currentRoute !== "practice") return;
        if (document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
        const k = e.key.toUpperCase();
        const keyMap = { "1": 0, "2": 1, "3": 2, "4": 3, "A": 0, "B": 1, "C": 2, "D": 3 };
        if (k in keyMap && optionBtns[keyMap[k]] && !optionBtns[keyMap[k]].disabled) {
          optionBtns[keyMap[k]].click();
        } else if (e.key === "Enter" && submitBtn && !submitBtn.disabled) {
          submitBtn.click();
        }
      };
      window.addEventListener("keydown", handleKeyNav);
    }

    if (skipBtn) {
      skipBtn.onclick = () => {
        AppState.quizSession.history.push({
          question: q.question,
          concept: q.conceptName,
          questionType: qType,
          userAnswer: "(Skipped)",
          isCorrect: false
        });
        updateQuizDonut();
        if (AppState.quizSession.currentIndex >= AppState.quizSession.totalQuestions) {
          renderQuizResults();
        } else {
          AppState.quizSession.currentIndex++;
          loadQuizQuestion(AppState.quizSession.currentConceptId);
        }
      };
    }

    if (submitBtn) {
      submitBtn.onclick = async () => {
        let typedVal = "";
        let numVal = null;
        if (qType === "fill_in_the_blanks") {
          typedVal = fitbInput ? fitbInput.value.trim() : "";
          if (!typedVal) return;
        } else if (qType === "typed_qa") {
          typedVal = typedQaInput ? typedQaInput.value.trim() : "";
          if (!typedVal) return;
        } else if (qType === "numerical") {
          typedVal = numericalInput ? numericalInput.value.trim() : "";
          if (!typedVal) return;
          numVal = parseFloat(typedVal);
        } else {
          if (selectedIdx === null) return;
        }

        submitBtn.disabled = true;
        skipBtn.disabled = true;
        if (fitbInput) fitbInput.disabled = true;
        if (typedQaInput) typedQaInput.disabled = true;
        if (numericalInput) numericalInput.disabled = true;
        if (scratchpadArea) scratchpadArea.disabled = true;
        optionBtns.forEach(b => (b.disabled = true));

        try {
          const scratchpadNote = scratchpadArea ? scratchpadArea.value.trim() : "";
          // Authoritative submission to backend supporting mixed question formats
          const result = await ApiService.submitAnswer(
            q.id,
            q.conceptId,
            selectedIdx,
            null,
            scratchpadNote || typedVal,
            typedVal,
            numVal
          );
          const isCorrect = Boolean(result.correct);
          const correctIdx = result.correctIndex !== undefined ? result.correctIndex : q.correct;
          const explanation = result.explanation || q.explanation || "Evaluation recorded in learner belief model.";
          const reasoningDepth = result.reasoning_depth_level || result.reasoningDepth || "EVALUATED";
          const correctDisplay = result.correct_answer_display || result.correctAnswerDisplay || q.targetBlankAnswer || q.target_blank_answer || "";
          const stepSolution = result.step_by_step_solution || result.stepByStepSolution || q.stepByStepSolution || q.step_by_step_solution || "";

          if (isCorrect) {
            AppState.quizSession.score++;
          }
          AppState.quizSession.history.push({
            question: q.question,
            concept: q.conceptName,
            questionType: qType,
            userAnswer: typedVal || (optionBtns[selectedIdx]?.innerText || `Option ${selectedIdx}`),
            isCorrect
          });

          // Style option buttons for MCQ
          if (qType === "mcq") {
            optionBtns.forEach((b, idx) => {
              if (idx === correctIdx) {
                b.classList.add("correct");
              } else if (idx === selectedIdx && !isCorrect) {
                b.classList.add("incorrect");
              }
            });
          }

          // Update session donut accuracy
          updateQuizDonut();

          // Render comprehensive feedback box
          const feedbackBox = $("#quiz-feedback-container");
          let reviewSnippet = "";

          if (qType === "fill_in_the_blanks") {
            reviewSnippet = `
              <div class="quiz-answer-review">
                <div>Your answer: <strong>${esc(typedVal)}</strong></div>
                ${!isCorrect ? `<div>Target keyword: <strong style="color:var(--color-strong);">${esc(correctDisplay)}</strong></div>` : ''}
              </div>
            `;
          } else if (qType === "typed_qa") {
            reviewSnippet = `
              <div class="quiz-answer-review">
                <div>AI Judge Assessment: <strong>${isCorrect ? 'Conceptual Comprehension Verified' : 'Needs Conceptual Clarification'}</strong> (Depth: <em>${esc(reasoningDepth)}</em>)</div>
                ${correctDisplay ? `<div style="margin-top:0.25rem; font-size:0.83rem;">Expected Concepts: ${esc(correctDisplay)}</div>` : ''}
              </div>
            `;
          } else if (qType === "numerical") {
            reviewSnippet = `
              <div class="quiz-answer-review">
                <div>Your calculated value: <strong>${esc(typedVal)}</strong></div>
                ${!isCorrect ? `<div>Target value: <strong style="color:var(--color-strong);">${esc(correctDisplay)}</strong></div>` : ''}
              </div>
              ${stepSolution ? `
                <div class="step-by-step-box">
                  <div class="step-by-step-header">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 14 14"/></svg>
                    <span>Step-by-Step Solution</span>
                  </div>
                  <div class="step-by-step-content">${esc(stepSolution)}</div>
                </div>
              ` : ''}
            `;
          }

          feedbackBox.innerHTML = `
            <div class="quiz-explanation-box ${isCorrect ? 'correct' : 'incorrect'}">
              <div style="display:flex; align-items:center; gap:0.5rem; margin-bottom:0.35rem; font-weight:700;">
                ${isCorrect ? `
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  <span>${qType === 'typed_qa' ? 'Concept Well Explained!' : (qType === 'numerical' ? 'Calculation Verified Correct!' : 'Correct!')}</span>
                ` : `
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  <span>${qType === 'typed_qa' ? 'Review Recommended.' : (qType === 'numerical' ? 'Calculation Variance Detected.' : 'Not quite.')}</span>
                `}
              </div>
              ${reviewSnippet}
              <p style="margin:0; font-size:0.9rem; margin-top:0.4rem;">${esc(explanation)}</p>
            </div>
          `;
          renderMath(feedbackBox);

          // Change submit button to next question
          submitBtn.disabled = false;
          submitBtn.textContent = AppState.quizSession.currentIndex >= AppState.quizSession.totalQuestions
            ? "View Quiz Results →"
            : "Next Question →";

          submitBtn.onclick = () => {
            if (AppState.quizSession.currentIndex >= AppState.quizSession.totalQuestions) {
              renderQuizResults();
            } else {
              AppState.quizSession.currentIndex++;
              loadQuizQuestion(AppState.quizSession.currentConceptId || result.next);
            }
          };
        } catch (e) {
          showToast(`Submission error: ${e.message}`, "danger");
          submitBtn.disabled = false;
        }
      };
    }
  }

  function updateQuizDonut() {
    const numEl = $("#quiz-perf-number");
    const donutEl = $("#quiz-perf-donut");
    const encourEl = $("#quiz-encouragement");
    if (!numEl || !donutEl) return;

    const answered = AppState.quizSession.history.length;
    if (answered === 0) {
      numEl.textContent = "0%";
      donutEl.innerHTML = createDonutSvg(0, 110, 8, "var(--primary)");
      if (encourEl) {
        encourEl.textContent = "Answer questions to sharpen your mastery profile.";
      }
      return;
    }
    const pct = Math.round((AppState.quizSession.score / answered) * 100);

    numEl.textContent = `${pct}%`;
    donutEl.innerHTML = createDonutSvg(pct, 110, 8, pct >= 70 ? "var(--color-strong)" : "var(--color-weak)");

    if (encourEl) {
      if (pct >= 80) encourEl.textContent = "Superb! Your concept mastery is soaring.";
      else if (pct >= 50) encourEl.textContent = "Good progress! Targeted review will solidify weak areas.";
      else encourEl.textContent = "Keep practicing! Reviewing prerequisites will help unlock these concepts.";
    }
  }

  function renderQuizResults() {
    const box = $("#quiz-card-box");
    if (!box) return;

    const total = AppState.quizSession.history.length;
    const correct = AppState.quizSession.score;
    const pct = total > 0 ? Math.round((correct / total) * 100) : 0;

    box.innerHTML = `
      <div style="padding:2.5rem; text-align:center;">
        <div class="donut-chart-container" style="margin:0 auto 1.5rem auto;">
          ${createDonutSvg(pct, 130, 10, pct >= 70 ? "var(--color-strong)" : "var(--color-weak)")}
          <div class="donut-chart-value">
            <span class="val-number">${pct}%</span>
            <span class="val-label">Final Score</span>
          </div>
        </div>

        <h2 style="margin-bottom:0.5rem;">Assessment Completed!</h2>
        <p style="margin-bottom:1.75rem;">
          You answered <strong>${correct} of ${total}</strong> questions correctly. Your epistemic belief model has been updated.
        </p>

        <div style="display:flex; justify-content:center; gap:1rem;">
          <button class="btn btn-primary" id="btn-restart-quiz">Start Another Quiz</button>
          <a href="#learning-path" class="btn btn-secondary">Review Learning Path &rarr;</a>
        </div>
      </div>
    `;

    const restartBtn = $("#btn-restart-quiz");
    if (restartBtn) {
      restartBtn.onclick = () => {
        startNewQuizSession(AppState.quizSession.currentConceptId);
      };
    }
  }

  // =========================================================================
  // ROUTING & APP INITIALIZATION
  // =========================================================================

  function updateNavigation(routeId) {
    $$(".nav-link").forEach(link => {
      const target = link.getAttribute("data-nav");
      link.classList.toggle("active", target === routeId);
    });

    const pageTitle = $("#topbar-page-title");
    if (pageTitle) {
      const titles = {
        dashboard: "Dashboard",
        upload: "Study Material",
        tutor: "AI Tutor",
        "active-recall": "Active Recall",
        "smart-notes": "Smart Notes",
        practice: "Concept Check",
        "learning-path": "Learning Path",
        progress: "Mastery Analytics",
        settings: "Settings"
      };
      pageTitle.textContent = titles[routeId] || "Platform";
    }

    const sidebar = $("#sidebar");
    if (sidebar && sidebar.classList.contains("open")) {
      sidebar.classList.remove("open");
    }
  }

  function navigate(routeId) {
    return navigateTo(routeId);
  }

  async function navigateTo(routeId) {
    const validRoutes = ["dashboard", "upload", "tutor", "active-recall", "smart-notes", "practice", "learning-path", "progress", "settings"];
    const activeRoute = validRoutes.includes(routeId) ? routeId : "dashboard";
    AppState.currentRoute = activeRoute;
    updateNavigation(activeRoute);

    const view = $("#view");
    if (!view) return;

    view.innerHTML = `
      <div style="padding:4rem 2rem; text-align:center; color:var(--ink-muted);">
        <div class="upload-icon-pulse" style="width:40px; height:40px; margin-bottom:1rem;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </div>
        Loading ${activeRoute}...
      </div>
    `;

    try {
      const html = await Views[toCamelCase(activeRoute)]();
      view.innerHTML = html;
      renderMath(view);
      if (AfterRender[toCamelCase(activeRoute)]) {
        AfterRender[toCamelCase(activeRoute)]();
      }
    } catch (err) {
      view.innerHTML = `
        <div class="card" style="padding:3rem; text-align:center;">
          <h2 style="color:var(--color-danger); margin-bottom:0.75rem;">Something went wrong</h2>
          <p style="margin-bottom:1.5rem;">${esc(err.message)}</p>
          <a href="#dashboard" class="btn btn-primary">Return to Dashboard</a>
        </div>
      `;
    }
  }

  function toCamelCase(str) {
    return str.replace(/-([a-z])/g, g => g[1].toUpperCase());
  }

  function handleHashChange() {
    const rawHash = location.hash.slice(1).trim();
    navigateTo(rawHash);
  }

  // Application Entry Point
  function initApp() {
    initTheme();
    initMobileNav();
    initModals();
    initAuth();

    window.addEventListener("hashchange", handleHashChange);
    
    // Global navigation listener for practice links, teacher deliberation modal, and timestamp chips
    document.addEventListener("click", (e) => {
      const tsChip = e.target.closest(".view-timestamp-chip, .timestamp-citation-chip");
      if (tsChip) {
        const sec = parseInt(tsChip.getAttribute("data-seconds"), 10);
        if (!isNaN(sec)) {
          window.openVideoPreviewAtTimestamp(sec);
        }
        return;
      }

      const citChip = e.target.closest(".view-citation-chip, .grounded-citation-chip");
      if (citChip) {
        const loc = citChip.getAttribute("data-loc");
        const type = citChip.getAttribute("data-type");
        showToast(`Grounding source anchor: ${type || 'Page'} ${loc || ''}`, "info");
        return;
      }

      const inspectBtn = e.target.closest(".btn-inspect-deliberation");
      if (inspectBtn) {
        const cid = inspectBtn.getAttribute("data-concept-id");
        const cname = inspectBtn.getAttribute("data-concept-name");
        openTeacherDeliberationModal(cid, cname);
        return;
      }

      const targetLink = e.target.closest("a[href='#practice'], button.start-target-quiz, a.start-target-quiz");
      if (targetLink) {
        const cid = targetLink.getAttribute("data-target-concept");
        AppState.quizSession.targetConceptId = cid || null;
        if (location.hash === "#practice") {
          navigateTo("practice");
        }
      }
    });

    handleHashChange();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp);
  } else {
    initApp();
  }
})();
