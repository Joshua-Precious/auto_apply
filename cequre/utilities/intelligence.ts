import type { CandidateFact, FactKind } from './contracts';

// Intelligence is provider-independent. Milestone 2 ships one implementation
// that performs no network or model calls: it extracts only what the supplied
// text states and matches only against supplied facts. A model provider can be
// added behind this interface, but its output must pass the same validators.

export interface InferenceUsage {
  model: string | null; prompt_version: string | null;
  input_tokens: number | null; output_tokens: number | null; browser_seconds: number;
}
export interface Requirement { id: string; text: string; importance: 'required' | 'preferred' | 'unknown'; source_quote: string }
export interface NormalizedJob {
  title: string | null; employer: string | null; location: string | null; seniority: string | null;
  experience_requirements: string[]; requirements: Requirement[];
  missing_information: string[]; limitations: string[];
}
export type AssessmentKind = 'supported' | 'partial' | 'not_evidenced' | 'unknown';
export interface RequirementAssessment { requirement_id: string; assessment: AssessmentKind; fact_ids: string[]; explanation: string }
export interface MatchAssessment {
  assessments: RequirementAssessment[];
  missing_information: string[]; recommendations: string[]; limitations: string[];
}
export interface TailoredCvItem { fact_ids: string[]; text: string }
export interface TailoredCvSection { heading: string; items: TailoredCvItem[] }
export interface TailoredCvSuggestion { fact_ids: string[]; text: string; review_status: 'unverified_suggestion' }
export interface TailoredCv {
  kind: 'tailored_cv'; mode: 'extractive';
  sections: TailoredCvSection[]; suggestions: TailoredCvSuggestion[]; limitations: string[];
}
export interface InferenceProvider {
  readonly mode: 'deterministic' | 'model';
  readonly version: string;
  analyzeJob(input: { text: string }): Promise<{ result: NormalizedJob; usage: InferenceUsage }>;
  match(input: { job: NormalizedJob; facts: CandidateFact[] }): Promise<{ result: MatchAssessment; usage: InferenceUsage }>;
  tailorCv(input: { job: NormalizedJob; facts: CandidateFact[] }): Promise<{ result: TailoredCv; usage: InferenceUsage }>;
}

const stopwords = new Set(`a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
ability able across additional advantage advantages applicant applicants application applications apply candidate candidates company companies consider degree degrees desirable duties employee employer employment ensure essential etc experience experienced familiarity familiar including job knowledge looking minimum must need needed needs opportunity position posting preferred proficiency proficient qualification qualifications require required requirement requirements responsibilities role skills strong successful team teams we're you'll work working year years plus bonus benefits salary remote hybrid onsite office`.split(/\s+/));
const shortSkills = new Set(['go', 'ai', 'ml', 'qa', 'ui', 'ux', 'c#', 'c++', 'js', 'ts', 'r']);

export function stem(token: string): string {
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}
export function terms(text: string, max = 14): string[] {
  const found: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const token = raw.replace(/^\.+|\.+$/g, '');
    if (!token || /^\d+$/.test(token)) continue;
    if (token.length < 3 && !shortSkills.has(token)) continue;
    if (stopwords.has(token)) continue;
    const value = stem(token);
    if (!found.includes(value)) found.push(value);
    if (found.length >= max) break;
  }
  return found;
}

function sentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '').trim();
    if (!cleaned) continue;
    for (const part of cleaned.split(/(?<=[.!?;])\s+/)) {
      const sentence = part.trim();
      if (sentence) out.push(sentence);
    }
  }
  return out;
}

const roleKeywords = /(engineer|developer|manager|designer|analyst|scientist|architect|consultant|specialist|administrator|writer|marketer|coordinator|director|officer|technician|nurse|teacher|intern|associate|lead)/i;
const titlePatterns = [
  /(?:seeks|is seeking|is hiring|is looking for|looking for|role of|position of|title\s*:)\s+(?:an?\s+|the\s+)?([A-Za-z][A-Za-z0-9/ +'-]{2,90}?)(?=\s+(?:with|who|to|for|in|at|that|and)\b|[.,;:!?\n]|$)/i,
];
const employerPatterns = [
  /^([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})\s+(?:seeks|is seeking|is hiring|is looking for|requires)\b/m,
  /(?:^|\n)\s*(?:company|employer|organisation|organization)\s*[:\-]\s*([A-Za-z][\w& .'-]{1,120}?)\s*(?:\n|$)/i,
];
const locationPatterns = [
  /(?:^|\n)\s*(?:location|based in|office|workplace)\s*[:\-]\s*([A-Za-z][A-Za-z .',()-]{1,80}?)\s*(?:\n|[.;]|$)/i,
  /\b(?:must be based in|role is based in|position is based in)\s+([A-Z][A-Za-z .',-]{1,60})/,
];
const seniorityPattern = /\b(intern|internship|junior|entry[- ]level|mid[- ]level|senior|staff|principal|lead|head of|director|chief)\b/i;
const cuePattern = /\b(must|required?|require|essential|minimum|at least|preferred|nice to have|desirable|is a plus|bonus|advantage|experience (?:with|in)|proficien\w*|knowledge of|familiar\w*|ability to|expertise|degree)\b/i;
const preferredPattern = /\b(preferred|nice to have|desirable|is a plus|bonus|advantage|ideally)\b/i;
const requiredPattern = /\b(must|required?|essential|minimum|at least)\b/i;
const yearsPattern = /\b\d+\s*\+?\s*(?:to|-)\s*\d+\s*\+?\s*years?\b|\b\d+\s*\+?\s*years?\b/i;

function firstMatch(patterns: RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim().replace(/[.,;:]+$/, '');
    if (value && value.length <= 160) return value.replace(/\s+/g, ' ');
  }
  return null;
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b[a-z]/g, letter => letter.toUpperCase());
}

export class DeterministicProvider implements InferenceProvider {
  readonly mode = 'deterministic' as const;
  readonly version = 'deterministic-v1';
  private usage(): InferenceUsage {
    return { model: null, prompt_version: this.version, input_tokens: null, output_tokens: null, browser_seconds: 0 };
  }
  async analyzeJob(input: { text: string }) {
    return { result: analyze(input.text), usage: this.usage() };
  }
  async match(input: { job: NormalizedJob; facts: CandidateFact[] }) {
    return { result: match(input.job, input.facts), usage: this.usage() };
  }
  async tailorCv(input: { job: NormalizedJob; facts: CandidateFact[] }) {
    return { result: tailor(input.job, input.facts), usage: this.usage() };
  }
}

export function analyze(text: string): NormalizedJob {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let title = firstMatch(titlePatterns, text);
  if (title && !roleKeywords.test(title)) title = null;
  if (!title) {
    const heading = lines.find(line => line.length <= 90 && roleKeywords.test(line) && !cuePattern.test(line));
    title = heading ? heading.replace(/[:\-–]\s*$/, '').trim() : null;
  }
  const employer = firstMatch(employerPatterns, text);
  const location = firstMatch(locationPatterns, text) ?? (/\bremote\b/i.test(text) ? 'Remote' : null);
  const seniorityMatch = seniorityPattern.exec(title ?? text);
  const seniority = seniorityMatch?.[1] ? titleCase(seniorityMatch[1].replace(/^head of$/i, 'Head')) : null;

  const requirements: Requirement[] = [];
  const seen = new Set<string>();
  for (const sentence of sentences(text)) {
    if (!cuePattern.test(sentence)) continue;
    if (sentence.length < 8) continue;
    if (sentence.length > 2000) continue;
    const text = sentence.length > 1000 ? `${sentence.slice(0, 997)}...` : sentence;
    if (seen.has(text)) continue;
    seen.add(text);
    requirements.push({
      id: `req-${requirements.length + 1}`,
      text,
      importance: preferredPattern.test(sentence) ? 'preferred' : requiredPattern.test(sentence) ? 'required' : 'unknown',
      // Verbatim source so a reviewer can confirm every requirement exists.
      source_quote: sentence,
    });
    if (requirements.length >= 100) break;
  }

  const experience = sentences(text).filter(sentence => yearsPattern.test(sentence)).slice(0, 30)
    .map(sentence => (sentence.length > 1000 ? `${sentence.slice(0, 997)}...` : sentence));

  const missing: string[] = [];
  if (!title) missing.push('The job title is not stated explicitly.');
  if (!employer) missing.push('The employer name is not stated explicitly.');
  if (!location) missing.push('The work location is not stated explicitly.');
  if (!seniority) missing.push('The seniority level is not stated explicitly.');
  if (!requirements.length) missing.push('No explicit requirement statements were detected in the supplied text.');
  if (!experience.length) missing.push('No explicit experience duration is stated.');

  return {
    title, employer, location, seniority, experience_requirements: experience, requirements,
    missing_information: missing,
    limitations: [
      'Deterministic extraction from the supplied text only; no language model is used in this release.',
      'Unstated expectations, implied requirements and recruiter intent are not inferred.',
    ],
  };
}

export function match(job: NormalizedJob, facts: CandidateFact[]): MatchAssessment {
  const factTerms = new Map<string, Set<string>>();
  for (const fact of facts) {
    factTerms.set(fact.id, new Set(terms([fact.text, fact.employer, fact.title, fact.institution, fact.credential].filter(Boolean).join(' '), 60)));
  }
  const assessments: RequirementAssessment[] = [];
  const missing: string[] = [];
  const recommendations: string[] = [];
  const perRequirement = job.requirements.length ? job.requirements : [];

  for (const requirement of perRequirement) {
    const wanted = terms(requirement.text);
    if (!wanted.length) {
      assessments.push({ requirement_id: requirement.id, assessment: 'unknown', fact_ids: [], explanation: 'The requirement contains no assessable skill or experience terms.' });
      continue;
    }
    const scored: { id: string; hits: string[] }[] = [];
    for (const [id, tokens] of factTerms) {
      const hits = wanted.filter(term => tokens.has(term));
      if (hits.length) scored.push({ id, hits });
    }
    scored.sort((left, right) => right.hits.length - left.hits.length || left.id.localeCompare(right.id));
    const best = scored[0]?.hits.length ?? 0;
    const ratio = best / wanted.length;
    let assessment: AssessmentKind = best === 0 ? 'not_evidenced' : ratio >= 0.6 ? 'supported' : 'partial';
    const matchedTerms = [...new Set(scored.flatMap(entry => entry.hits))].slice(0, 6);
    const missingTerms = wanted.filter(term => !matchedTerms.includes(term)).slice(0, 6);
    const picked = scored.filter(entry => entry.hits.length).sort((left, right) => right.hits.length - left.hits.length).slice(0, 5).map(entry => entry.id).sort();
    // A duration requirement cannot be satisfied by keyword overlap alone.
    const tenureRequired = yearsPattern.test(requirement.text);
    const tenureEvidenced = facts.some(fact => Boolean(fact.start_date));
    const tenureCaveat = tenureRequired && !tenureEvidenced;
    if (tenureCaveat && assessment !== 'not_evidenced') assessment = 'partial';
    const explanation = assessment === 'not_evidenced'
      ? `Supplied facts do not mention: ${missingTerms.join(', ') || 'this requirement'}.`
      : `Supplied facts reference: ${matchedTerms.join(', ')}${missingTerms.length ? `; not evidenced: ${missingTerms.join(', ')}` : ''}${tenureCaveat ? '; tenure is not evidenced by supplied dates' : ''}.`;
    assessments.push({
      requirement_id: requirement.id, assessment, fact_ids: assessment === 'not_evidenced' ? [] : picked, explanation,
    });
    if (assessment === 'not_evidenced' && requirement.importance !== 'unknown' && recommendations.length < 10) {
      recommendations.push(`Add verified evidence for a ${requirement.importance} requirement: ${requirement.text.slice(0, 300)}`);
    }
  }

  if (facts.length < 5) missing.push(`Sparse candidate snapshot (${facts.length} fact${facts.length === 1 ? '' : 's'}); assessments can understate the candidate's experience.`);
  if (!facts.some(fact => fact.kind === 'experience' && fact.start_date)) missing.push('Experience dates are not supplied, so tenure and recency cannot be assessed.');
  if (!job.requirements.length) missing.push('The job text contains no detectable requirements, so no evidence can be compared.');

  recommendations.push('Review each assessment against the candidate\'s own records; keyword overlap is not proof of a qualification.');
  return {
    assessments, missing_information: missing, recommendations: recommendations.slice(0, 12),
    limitations: [
      'Explainable evidence review only: this is not a probability of being hired and must not be presented as one.',
      'Deterministic keyword overlap; synonyms, equivalences and unstated experience are not inferred.',
    ],
  };
}

// --- Extractive tailoring ----------------------------------------------------
// M3 ships extractive mode only: every line is either the exact submitted fact
// text or an exact rendering of that fact's immutable employer/title/
// institution/credential/date fields. Nothing is paraphrased, added or reordered
// in a way that changes a value, so a reviewer can diff the artifact against the
// snapshot they sent.

const sectionFor: [FactKind, string][] = [
  ['summary', 'Profile'], ['skill', 'Skills'], ['experience', 'Experience'],
  ['education', 'Education'], ['certification', 'Certifications'],
  ['project', 'Projects'], ['achievement', 'Achievements'],
];

/** The only two allowed renderings of a supplied fact. */
export function factLine(fact: CandidateFact): string {
  const head: string[] = [];
  if (fact.title) head.push(fact.title);
  if (fact.employer) head.push(head.length ? `at ${fact.employer}` : fact.employer);
  if (fact.institution) head.push(head.length ? `at ${fact.institution}` : fact.institution);
  if (fact.credential) head.push(head.length ? `- ${fact.credential}` : fact.credential);
  let period = '';
  if (fact.start_date) period = `${fact.start_date} - ${fact.end_date === null || fact.end_date === undefined ? 'present' : fact.end_date}`;
  else if (fact.end_date) period = `until ${fact.end_date}`;
  const label = [head.join(' '), period ? `(${period})` : ''].filter(Boolean).join(' ');
  return label ? `${label}: ${fact.text}` : fact.text;
}

function relevance(job: NormalizedJob, fact: CandidateFact): number {
  const wanted = new Set<string>();
  for (const requirement of job.requirements) for (const term of terms(requirement.text, 20)) wanted.add(term);
  if (job.title) for (const term of terms(job.title, 10)) wanted.add(term);
  const own = new Set(terms([fact.text, fact.employer, fact.title, fact.institution, fact.credential].filter(Boolean).join(' '), 60));
  let score = 0;
  for (const term of wanted) if (own.has(term)) score += 1;
  return score;
}

export function tailor(job: NormalizedJob, facts: CandidateFact[]): TailoredCv {
  const ranked = [...facts].sort((left, right) =>
    relevance(job, right) - relevance(job, left)
    || (left.end_date ?? left.start_date ?? '9999').localeCompare(right.end_date ?? right.start_date ?? '9999') * -1
    || left.id.localeCompare(right.id));

  const sections: TailoredCvSection[] = [];
  for (const [kind, heading] of sectionFor) {
    const items = ranked.filter(fact => fact.kind === kind).map(fact => ({ fact_ids: [fact.id], text: factLine(fact) }));
    if (items.length) sections.push({ heading, items });
  }

  // Gaps are reported, never filled. Only explicit, non-unknown requirement
  // statements are named, and the wording makes clear this is an absence of
  // supplied evidence rather than a judgement about the candidate.
  const assessment = match(job, facts);
  const gaps = assessment.assessments
    .filter(entry => entry.assessment === 'not_evidenced')
    .map(entry => job.requirements.find(requirement => requirement.id === entry.requirement_id))
    .filter((requirement): requirement is Requirement => Boolean(requirement) && requirement!.importance !== 'unknown')
    .slice(0, 5)
    .map(requirement => `No supplied fact evidences: ${requirement.text.slice(0, 300)}`);

  return {
    kind: 'tailored_cv', mode: 'extractive', sections, suggestions: [],
    limitations: [
      'Extractive mode: each line is the submitted fact text or its exact title, employer, institution, credential and date values. Nothing is paraphrased, added or omitted from a value.',
      'No phrasing suggestions are produced in deterministic mode. A model provider must return them separately, labelled unverified_suggestion, and they never enter an approved document automatically.',
      'The original CV was not modified; this artifact is a separate versioned document.',
      ...gaps,
      ...(facts.some(fact => !fact.start_date) ? ['Some supplied facts have no dates, so chronology is not implied by the ordering.'] : []),
    ],
  };
}

// --- Output validation -------------------------------------------------------
// Applied by the worker to every provider result (including future model
// output) before it can be stored or returned to a caller.

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function notes(value: unknown, field: string): asserts value is string[] {
  assert(Array.isArray(value) && value.length <= 100, `${field} must be an array of at most 100 strings`);
  for (const entry of value) assert(typeof entry === 'string' && [...entry].length <= 2000, `${field} contains an invalid note`);
}
const forbiddenKeys = /^(score|match_score|probability|likelihood|confidence)$/i;
function assertNoScores(value: unknown, path = 'result') {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assert(!forbiddenKeys.test(key), `${path}.${key} is not an allowed output field`);
    assertNoScores(entry, `${path}.${key}`);
  }
}

export function validateNormalizedJob(value: unknown, sourceText: string): NormalizedJob {
  const job = value as NormalizedJob;
  assert(job && typeof job === 'object', 'job result must be an object');
  assertNoScores(job);
  for (const field of ['title', 'employer', 'location', 'seniority'] as const) {
    assert(job[field] === null || (typeof job[field] === 'string' && [...(job[field] as string)].length <= 160), `job.${field} is invalid`);
  }
  assert(Array.isArray(job.experience_requirements) && job.experience_requirements.length <= 30, 'job.experience_requirements is invalid');
  for (const entry of job.experience_requirements) assert(typeof entry === 'string' && [...entry].length <= 1000, 'job.experience_requirements contains an invalid entry');
  assert(Array.isArray(job.requirements) && job.requirements.length <= 100, 'job.requirements is invalid');
  const ids = new Set<string>();
  for (const requirement of job.requirements) {
    assert(requirement && typeof requirement === 'object', 'job.requirements contains an invalid entry');
    assert(typeof requirement.id === 'string' && [...requirement.id].length <= 80 && !ids.has(requirement.id), 'job.requirements has an invalid or duplicate id');
    ids.add(requirement.id);
    assert(typeof requirement.text === 'string' && [...requirement.text].length <= 1000, 'job requirement text is invalid');
    assert(['required', 'preferred', 'unknown'].includes(requirement.importance), 'job requirement importance is invalid');
    assert(typeof requirement.source_quote === 'string' && [...requirement.source_quote].length <= 2000, 'job requirement quote is invalid');
    // Grounding: every quote must literally occur in the submitted job text.
    assert(sourceText.includes(requirement.source_quote), `job requirement ${requirement.id} is not grounded in the submitted text`);
  }
  notes(job.missing_information, 'job.missing_information');
  notes(job.limitations, 'job.limitations');
  return job;
}

export function validateMatchAssessment(value: unknown, factIds: string[], requirementIds: string[]): MatchAssessment {
  const assessment = value as MatchAssessment;
  assert(assessment && typeof assessment === 'object', 'match result must be an object');
  assertNoScores(assessment);
  assert(Array.isArray(assessment.assessments) && assessment.assessments.length <= 100, 'match.assessments is invalid');
  const allowedFacts = new Set(factIds);
  const allowedRequirements = new Set(requirementIds);
  const seen = new Set<string>();
  for (const entry of assessment.assessments) {
    assert(entry && typeof entry === 'object', 'match.assessments contains an invalid entry');
    assert(typeof entry.requirement_id === 'string' && allowedRequirements.has(entry.requirement_id) && !seen.has(entry.requirement_id), 'match.assessments references an unknown or duplicate requirement');
    seen.add(entry.requirement_id);
    assert(['supported', 'partial', 'not_evidenced', 'unknown'].includes(entry.assessment), 'match assessment kind is invalid');
    assert(Array.isArray(entry.fact_ids) && entry.fact_ids.length <= 200 && new Set(entry.fact_ids).size === entry.fact_ids.length, 'match.assessments fact_ids is invalid');
    for (const id of entry.fact_ids) assert(typeof id === 'string' && allowedFacts.has(id), 'match.assessments cites a fact outside the submitted snapshot');
    assert(typeof entry.explanation === 'string' && [...entry.explanation].length <= 2000, 'match.assessments explanation is invalid');
    if (entry.assessment === 'not_evidenced') assert(entry.fact_ids.length === 0, 'a not_evidenced assessment cannot cite facts');
  }
  notes(assessment.missing_information, 'match.missing_information');
  notes(assessment.recommendations, 'match.recommendations');
  notes(assessment.limitations, 'match.limitations');
  return assessment;
}

/**
 * Grounding gate for tailored CVs, applied to every provider (deterministic or
 * model) before anything is persisted. A line is accepted only when it is
 * byte-identical to the submitted fact text or to that fact's exact field
 * rendering, so paraphrasing, invented achievements and altered credentials are
 * rejected instead of being stored.
 */
export function validateTailoredCv(value: unknown, facts: CandidateFact[]): TailoredCv {
  const cv = value as TailoredCv;
  const byId = new Map(facts.map(fact => [fact.id, fact] as const));
  assert(cv && typeof cv === 'object', 'tailoring result must be an object');
  assertNoScores(cv);
  assert(cv.kind === 'tailored_cv', 'tailoring result kind is invalid');
  assert(cv.mode === 'extractive', 'tailoring result mode is invalid');

  const grounded = (item: { fact_ids: unknown; text: unknown }, path: string) => {
    assert(Array.isArray(item.fact_ids) && item.fact_ids.length >= 1 && item.fact_ids.length <= 200, `${path} must cite at least one fact`) ;
    assert(new Set(item.fact_ids as unknown[]).size === item.fact_ids.length, `${path} cites a duplicate fact`);
    const cited: CandidateFact[] = [];
    for (const id of item.fact_ids) {
      assert(typeof id === 'string' && [...id].length <= 80, `${path} contains an invalid fact id`);
      const fact = byId.get(id as string);
      assert(fact, `${path} cites a fact outside the submitted snapshot`);
      cited.push(fact as CandidateFact);
    }
    assert(typeof item.text === 'string' && [...item.text].length >= 1 && [...item.text].length <= 2000, `${path}.text is invalid`);
    const text = item.text as string;
    assert(cited.some(fact => text === fact.text || text === factLine(fact)), `${path}.text is not the exact supplied fact text or field rendering`);
  };

  assert(Array.isArray(cv.sections) && cv.sections.length <= 20, 'tailoring sections are invalid');
  const headings = new Set<string>();
  let items = 0;
  for (const [index, section] of cv.sections.entries()) {
    assert(section && typeof section === 'object', `sections[${index}] is invalid`);
    assert(typeof section.heading === 'string' && [...section.heading].length >= 1 && [...section.heading].length <= 100, `sections[${index}].heading is invalid`);
    assert(!headings.has(section.heading), `sections[${index}].heading is duplicated`);
    headings.add(section.heading);
    assert(Array.isArray(section.items) && section.items.length >= 1 && section.items.length <= 200, `sections[${index}].items is invalid`);
    items += section.items.length;
    for (const [position, item] of section.items.entries()) grounded(item as unknown as { fact_ids: unknown; text: unknown }, `sections[${index}].items[${position}]`);
  }
  assert(items <= 400, 'the tailored CV contains too many items');

  assert(Array.isArray(cv.suggestions) && cv.suggestions.length <= 100, 'tailoring suggestions are invalid');
  for (const [index, suggestion] of cv.suggestions.entries()) {
    assert(suggestion && typeof suggestion === 'object', `suggestions[${index}] is invalid`);
    assert(suggestion.review_status === 'unverified_suggestion', `suggestions[${index}].review_status must be unverified_suggestion`);
    assert(Array.isArray(suggestion.fact_ids) && suggestion.fact_ids.length >= 1, `suggestions[${index}] must cite at least one fact`);
    for (const id of suggestion.fact_ids) assert(typeof id === 'string' && byId.has(id), `suggestions[${index}] cites a fact outside the submitted snapshot`);
    assert(typeof suggestion.text === 'string' && [...suggestion.text].length >= 1 && [...suggestion.text].length <= 2000, `suggestions[${index}].text is invalid`);
  }

  notes(cv.limitations, 'tailoring limitations');
  // A document with no grounded lines is not a usable artifact; failing closed
  // is better than returning an empty CV as success.
  assert(items >= 1, 'the tailored CV contains no grounded facts');
  return cv;
}
