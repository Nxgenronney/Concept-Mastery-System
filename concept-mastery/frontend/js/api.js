/**
 * Concept Mastery Platform - API Client
 * Centralized communication layer connecting the frontend to FastAPI backend endpoints.
 */

const API_CONFIG = {
  mock: false,
  base: "",
  storageKey: "concept_mastery_config_v1"
};

/**
 * Automatically determine the backend base URL.
 * When the frontend is viewed on a different port (e.g. port 5500 in IDE preview)
 * or via file://, auto-direct traffic to the FastAPI backend on port 8000.
 */
function getAutoBackendBase() {
  if (typeof window !== "undefined" && window.location) {
    if (window.location.protocol === "file:" || (window.location.port && window.location.port !== "8000")) {
      const host = window.location.hostname || "localhost";
      return `http://${host}:8000`;
    }
  }
  return "";
}

function getEffectiveBase() {
  if (API_CONFIG.base && typeof API_CONFIG.base === "string" && API_CONFIG.base.trim()) {
    return API_CONFIG.base.trim().replace(/\/+$/, "");
  }
  return getAutoBackendBase();
}

// Load persisted configuration if available
try {
  const saved = localStorage.getItem(API_CONFIG.storageKey);
  if (saved) {
    const parsed = JSON.parse(saved);
    if (typeof parsed.mock === "boolean") API_CONFIG.mock = parsed.mock;
    if (typeof parsed.base === "string" && parsed.base.trim()) API_CONFIG.base = parsed.base.trim();
  }
} catch (e) {
  console.warn("Could not read API config from localStorage", e);
}

const ENDPOINTS = {
  health:           { method: "GET",  path: "/api/health" },
  ingest:           { method: "POST", path: "/api/ingest" },
  ingestUpload:     { method: "POST", path: "/api/ingest/upload" },
  ingestSample:     { method: "POST", path: "/api/ingest/sample" },
  ingestStatus:     { method: "GET",  path: "/api/ingest/status" },
  ask:              { method: "POST", path: "/api/tutor/ask" },
  webSearch:        { method: "POST", path: "/api/web/search" },
  graph:            { method: "GET",  path: "/api/graph" },
  conceptsGraph:    { method: "GET",  path: "/api/concepts/graph" },
  quizNext:         { method: "POST", path: "/api/quiz/next" },
  quizAnswer:       { method: "POST", path: "/api/quiz/answer" },
  quizEvaluate:     { method: "POST", path: "/api/quiz/evaluate" },
  mastery:          { method: "GET",  path: "/api/mastery" },
  masteryDashboard: { method: "GET",  path: "/api/mastery/dashboard" },
  masteryReset:     { method: "POST", path: "/api/mastery/reset" },
  loopNextAction:   { method: "POST", path: "/api/loop/next-action" },
  recommend:        { method: "POST", path: "/api/recommend" },
  materialsList:       { method: "GET",    path: "/api/materials" },
  materialsIngestFile: { method: "POST",   path: "/api/materials/ingest-file" },
  materialsIngestUrl:  { method: "POST",   path: "/api/materials/ingest-url" },
  materialsPreview:    { method: "GET",    path: "/api/materials/{material_id}/preview" },
  materialsDelete:     { method: "DELETE", path: "/api/materials/{material_id}" },
  loopStatus:          { method: "GET",    path: "/api/loop/status" },
  diagnosticStart:     { method: "POST",   path: "/api/diagnostic/start" },
  diagnosticSubmit:    { method: "POST",   path: "/api/diagnostic/submit" },
  quizRemedial:        { method: "POST",   path: "/api/quiz/remedial" },
  activeRecallStart:   { method: "POST",   path: "/api/active-recall/start" },
  activeRecallEvaluate:{ method: "POST",   path: "/api/active-recall/evaluate" },
  activeRecallHistory: { method: "GET",    path: "/api/active-recall/history" },
  authGoogle:          { method: "POST",   path: "/api/auth/google" },
  authMe:              { method: "GET",    path: "/api/auth/me" },
  authLogs:            { method: "GET",    path: "/api/auth/logs" },
  authConfig:          { method: "GET",    path: "/api/auth/config" },
  notesGenerate:       { method: "POST",   path: "/api/notes/generate" },
  notesList:           { method: "GET",    path: "/api/notes" },
  notesDelete:         { method: "DELETE", path: "/api/notes/{note_id}" },
  notesAudio:          { method: "POST",   path: "/api/notes/{note_id}/audio" },
  notesExport:         { method: "POST",   path: "/api/notes/{note_id}/export" },
  materialDeepAudio:   { method: "POST",   path: "/api/materials/{material_id}/deep-audio" },
  toolsGenerate:       { method: "POST",   path: "/api/tools/generate" },
  artifactFile:        { method: "GET",    path: "/api/artifacts/{filename}" },
  medicalVerificationStatus: { method: "GET", path: "/api/auth/medical-verification" },
  verifyMedicalId:     { method: "POST",   path: "/api/auth/verify-medical-id", isFormData: true },
  emailChallengeReq:   { method: "POST",   path: "/api/auth/email-verification/request" },
  emailChallengeVerify:{ method: "POST",   path: "/api/auth/email-verification/verify" }
};

/**
 * Core API caller with error parsing and mock support
 */
async function callApi(endpointKey, payload = null, options = {}) {
  const ep = ENDPOINTS[endpointKey];
  if (!ep) throw new Error(`Unknown endpoint: ${endpointKey}`);

  if (API_CONFIG.mock) {
    if (typeof MOCK !== "undefined" && typeof MOCK[endpointKey] === "function") {
      return await MOCK[endpointKey](payload);
    }
    throw new Error(`Mock implementation missing for ${endpointKey}`);
  }

  const base = getEffectiveBase();
  let cleanPath = ep.path.startsWith("/") ? ep.path : `/${ep.path}`;
  if (options && options.pathParams) {
    for (const [k, v] of Object.entries(options.pathParams)) {
      cleanPath = cleanPath.replace(`{${k}}`, encodeURIComponent(v));
    }
  }
  let url = `${base}${cleanPath}`;
  if (options && options.params) {
    const qs = new URLSearchParams(options.params).toString();
    if (qs) url += (url.includes("?") ? "&" : "?") + qs;
  }
  const fetchOpts = {
    method: ep.method,
    headers: {}
  };

  const authToken = ApiService.getToken();
  if (authToken) {
    fetchOpts.headers["Authorization"] = `Bearer ${authToken}`;
  }

  if (payload instanceof FormData) {
    fetchOpts.body = payload;
  } else if (payload && ep.method !== "GET") {
    fetchOpts.headers["Content-Type"] = "application/json";
    fetchOpts.body = JSON.stringify(payload);
  }

  let response;
  try {
    response = await fetch(url, fetchOpts);
  } catch (netErr) {
    throw new Error(`Network error connecting to backend: ${netErr.message}`);
  }

  if (response.status === 401) {
    ApiService.clearAuth();
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("cm:unauthorized"));
    }
  }

  let data;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      data = await response.json();
    } catch (e) {
      data = null;
    }
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    let message = "";
    let detail = null;
    if (data && typeof data === "object") {
      detail = data.detail || data;
      message = (typeof detail === "object" ? detail.message || detail.code : detail) || data.message || data.error;
    } else if (typeof data === "string") {
      message = data;
    }
    const err = new Error(message || `${endpointKey} failed with HTTP ${response.status}`);
    err.status = response.status;
    err.detail = detail || data;
    err.code = (detail && typeof detail === "object" && detail.code) || "";
    throw err;
  }

  return data;
}

// Convenience API services
const ApiService = {
  async getHealth() {
    return callApi("health");
  },

  async getIngestStatus() {
    return callApi("ingestStatus");
  },

  async uploadPdf(files) {
    const formData = new FormData();
    if (files instanceof FileList || Array.isArray(files)) {
      for (let i = 0; i < files.length; i++) {
        formData.append("files", files[i]);
      }
    } else if (files instanceof File) {
      formData.append("files", files);
    }
    return callApi("ingest", formData);
  },

  async searchWeb(query, maxResults = 5) {
    return callApi("webSearch", { query, max_results: maxResults });
  },

  async loadSamplePdf() {
    return callApi("ingestSample");
  },

  async askTutor(question, docId = null) {
    return callApi("ask", { question, docId });
  },

  async getGraph() {
    return callApi("graph");
  },

  async getConceptsGraph() {
    return callApi("conceptsGraph");
  },

  async getMasteryDashboard() {
    return callApi("masteryDashboard");
  },

  async getLoopNextAction() {
    return callApi("loopNextAction");
  },

  async evaluateAnswer(conceptId, questionText, studentAnswer, groundTruth = "") {
    return callApi("quizEvaluate", {
      conceptId,
      questionText,
      studentAnswer,
      groundTruth
    });
  },

  async getNextQuestion(conceptId = null) {
    return callApi("quizNext", { conceptId });
  },

  /**
   * Submit quiz answer for authoritative backend evaluation (supports MCQ, FITB, Typed Q&A, and Numerical)
   */
  async submitAnswer(questionId, conceptId, selectedIndex = null, correct = null, studentReasoning = "", typedAnswer = "", numericAnswer = null) {
    const payload = {
      questionId,
      conceptId,
      selectedIndex: selectedIndex !== null ? selectedIndex : undefined,
      correct: correct !== null ? correct : undefined,
      studentReasoning: studentReasoning || undefined,
      typedAnswer: typedAnswer || undefined,
      numericAnswer: numericAnswer !== null && numericAnswer !== undefined ? numericAnswer : undefined,
      numeric_answer: numericAnswer !== null && numericAnswer !== undefined ? numericAnswer : undefined
    };
    return callApi("quizAnswer", payload);
  },

  async getLoopStatus(userId = "default") {
    return callApi("loopStatus", null, { params: { user_id: userId } });
  },

  async startDiagnostic(userId = "default") {
    return callApi("diagnosticStart", { user_id: userId });
  },

  async submitDiagnostic(answers, userId = "default") {
    return callApi("diagnosticSubmit", { user_id: userId, answers });
  },

  async getRemedialQuiz(conceptId = null, userId = "default") {
    return callApi("quizRemedial", { concept_id: conceptId, conceptId, user_id: userId });
  },

  async startActiveRecall(conceptId, userId = "default") {
    return callApi("activeRecallStart", { concept_id: conceptId, user_id: userId });
  },

  async evaluateActiveRecall(conceptId, recallText, verificationAnswer = "", studyDurationSeconds = 0, userId = "default", sessionId = "") {
    return callApi("activeRecallEvaluate", {
      concept_id: conceptId,
      recall_text: recallText,
      verification_answer: verificationAnswer,
      study_duration_seconds: studyDurationSeconds,
      user_id: userId,
      session_id: sessionId
    });
  },

  async getActiveRecallHistory(conceptId = null, userId = "default") {
    const params = { user_id: userId };
    if (conceptId) params.concept_id = conceptId;
    return callApi("activeRecallHistory", null, { params });
  },

  async getMastery() {
    return callApi("mastery");
  },

  async resetMastery() {
    return callApi("masteryReset");
  },

  async getRecommendations() {
    return callApi("recommend");
  },

  async listMaterials(userId = "default") {
    return callApi("materialsList", null, { params: { user_id: userId } });
  },

  async ingestMaterialFile(files, userId = "default", title = "") {
    const formData = new FormData();
    const fileList = Array.isArray(files) ? files : [files];
    fileList.forEach(f => formData.append("files", f));
    if (userId) formData.append("user_id", userId);
    if (title) formData.append("title", title);
    return callApi("materialsIngestFile", formData);
  },

  async ingestMaterialUrl(url, sourceType = "auto", userId = "default", title = "") {
    return callApi("materialsIngestUrl", {
      url: url.trim(),
      source_type: sourceType,
      user_id: userId,
      title: title || undefined
    });
  },

  async getMaterialPreview(materialId) {
    return callApi("materialsPreview", null, { pathParams: { material_id: materialId } });
  },

  async deleteMaterial(materialId, userId = "default") {
    return callApi("materialsDelete", null, {
      pathParams: { material_id: materialId },
      params: { user_id: userId }
    });
  },

  // ── Smart Study Notes & Multimodal Artifacts ───────────────────────────────

  async generateNote(req) {
    return callApi("notesGenerate", req);
  },

  async getNotes(conceptId = null, userId = null) {
    const params = {};
    if (conceptId) params.concept_id = conceptId;
    if (userId) params.user_id = userId;
    const res = await callApi("notesList", null, { params });
    return Array.isArray(res) ? res : (res && Array.isArray(res.notes) ? res.notes : []);
  },

  async deleteNote(noteId, userId = null) {
    const params = {};
    if (userId) params.user_id = userId;
    return callApi("notesDelete", null, {
      pathParams: { note_id: noteId },
      params
    });
  },

  async generateNoteAudio(noteId, userId = null) {
    const params = {};
    if (userId) params.user_id = userId;
    return callApi("notesAudio", null, {
      pathParams: { note_id: noteId },
      params
    });
  },

  async exportNoteArtifact(noteId, exportFormat = "pdf", userId = null) {
    const fmt = exportFormat.toLowerCase().trim();
    const params = { export_format: fmt };
    if (userId) params.user_id = userId;
    return callApi("notesExport", { export_format: fmt }, {
      pathParams: { note_id: noteId },
      params
    });
  },

  async generateDeepAudio(materialId, sectionOrSlideIndex = 0, userId = null) {
    return callApi("materialDeepAudio", {
      section_or_slide_index: sectionOrSlideIndex,
      user_id: userId || "default"
    }, {
      pathParams: { material_id: materialId }
    });
  },

  async generateToolArtifact(toolType, conceptId, prompt = "", slideCount = 5, userId = null) {
    return callApi("toolsGenerate", {
      tool_type: toolType,
      concept_id: conceptId,
      prompt: prompt || "",
      slide_count: slideCount,
      user_id: userId || "default"
    });
  },

  getArtifactUrl(pathOrFilename) {
    if (!pathOrFilename) return "";
    if (pathOrFilename.startsWith("http://") || pathOrFilename.startsWith("https://")) {
      return pathOrFilename;
    }
    const base = getEffectiveBase();
    let clean = pathOrFilename;
    if (!clean.startsWith("/")) {
      clean = `/api/artifacts/${clean}`;
    }
    return base ? `${base}${clean}` : clean;
  },

  // ── Authentication & Session Management ─────────────────────────────────────

  getToken() {
    try {
      return localStorage.getItem("cm_access_token") || "";
    } catch {
      return "";
    }
  },

  setToken(token) {
    try {
      localStorage.setItem("cm_access_token", token);
    } catch (e) {
      console.warn("Could not set access token in localStorage", e);
    }
  },

  getUser() {
    try {
      const u = localStorage.getItem("cm_user");
      return u ? JSON.parse(u) : null;
    } catch {
      return null;
    }
  },

  setUser(user) {
    try {
      localStorage.setItem("cm_user", JSON.stringify(user));
    } catch (e) {
      console.warn("Could not set user profile in localStorage", e);
    }
  },

  clearAuth() {
    try {
      localStorage.removeItem("cm_access_token");
      localStorage.removeItem("cm_user");
    } catch {}
  },

  isAuthenticated() {
    return Boolean(this.getToken());
  },

  async loginGoogle(credential) {
    const res = await callApi("authGoogle", { credential });
    if (res && res.access_token) {
      this.setToken(res.access_token);
      if (res.user) {
        this.setUser(res.user);
      }
    }
    return res;
  },

  async getCurrentUser() {
    return callApi("authMe");
  },

  async getLoginLogs(limit = 10) {
    return callApi("authLogs", null, { params: { limit } });
  },

  async getAuthConfig() {
    return callApi("authConfig");
  },

  logout() {
    this.clearAuth();
    return true;
  },

  async getMedicalVerificationStatus() {
    return callApi("medicalVerificationStatus");
  },

  async verifyMedicalId(formData) {
    return callApi("verifyMedicalId", formData);
  },

  async requestEmailVerification(email) {
    return callApi("emailChallengeReq", { email });
  },

  async verifyEmailCode(email, code) {
    return callApi("emailChallengeVerify", { email, code });
  },

  saveConfig(newConfig) {
    Object.assign(API_CONFIG, newConfig);
    try {
      localStorage.setItem(API_CONFIG.storageKey, JSON.stringify({
        mock: API_CONFIG.mock,
        base: API_CONFIG.base
      }));
    } catch (e) {
      console.warn("Failed saving API config", e);
    }
  },

  getConfig() {
    return {
      ...API_CONFIG,
      effectiveBase: getEffectiveBase()
    };
  }
};

// Global helper for determining concept status
function getConceptStatus(concept) {
  if (!concept) return "unknown";
  if (concept.status) return concept.status;
  if (!concept.attempts || concept.attempts < 2) return "unknown";
  return concept.score >= 0.7 ? "strong" : "weak";
}

window.ApiService = ApiService;
window.getConceptStatus = getConceptStatus;
