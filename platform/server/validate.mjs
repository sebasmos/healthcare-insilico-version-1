// Structural validation for stored documents. Not a full FHIR profile
// validator: it enforces resource type, id shape and the R4 fields with
// minimum cardinality 1 for the types this platform uses.
export const FHIR_TYPES = new Set([
  'Patient', 'Practitioner', 'PractitionerRole', 'Organization', 'Location', 'Encounter', 'Condition',
  'AllergyIntolerance', 'Medication', 'MedicationRequest', 'Observation', 'DocumentReference',
  'ServiceRequest', 'DiagnosticReport', 'ImagingStudy', 'Appointment', 'Schedule', 'Slot',
  'Communication', 'Task', 'Provenance', 'AuditEvent', 'List', 'CareTeam', 'Procedure', 'Immunization',
  'Coverage', 'Claim', 'Account', 'ChargeItem', 'AdverseEvent',
  'DetectedIssue', 'MedicationDispense', 'MedicationAdministration', 'CarePlan', 'Goal', 'Specimen', 'Device', 'DeviceMetric',
  'Consent', 'Subscription', 'MedicationStatement', 'FamilyMemberHistory', 'Composition', 'QuestionnaireResponse',
]);

export const INTERNAL_TYPES = new Set([
  'Run', 'TraceStep', 'EvalCase', 'Agent', 'Episode', 'RedTeamScenario', 'AnnotationProject',
  'ScribeBenchmarkCase', 'KillSwitch', 'GateConfig', 'RewardConfig', 'CapturePolicy', 'GradeConfig', 'LabConfig', 'Hl7Message', 'CdsService',
  'Study', 'StudyLink', 'Review', 'Correction', 'Redaction', 'DatasetSnapshot', 'BenchCondition', 'Scenario', 'WearableSummary', 'RedTeamTest', 'ApiKey', 'Session', 'SignInLog', 'Adjudication', 'ExpertGrade', 'TrainingRun', 'EvalStudy', 'Attempt', 'PersonAccount', 'TaskVersion', 'TaskSet', 'LoopEvent', 'AgentSecret', 'DicomObject', 'UpsWorkitem', 'SdcDevice', 'XdsDocument', 'Visit', 'VisitCharge', 'InsProfile', 'InsPlan', 'InsCoverage', 'InsMember', 'InsMessage', 'InsPolicy', 'InsAuth', 'InsCase', 'InsRuleLog', 'InsLetter', 'InsPeer', 'InsAppeal', 'InsCoding', 'InsQuery', 'InsClaim', 'InsPayerClaim', 'InsEob', 'InsEstimate', 'InsComplaint', 'InsSubscription', 'InsAudit', 'InsStay', 'InsHarm', 'InsDispute', 'InsScenarioRun', 'LoginRecord', 'UnlockAttempt', 'SmartClient', 'SmartToken', 'SubscriptionEvent', 'ConnectorKey', 'ScheduledMessage', 'SurvSettings', 'SurvSignal', 'SurvWatch', 'SurvReview', 'SurvStudy', 'SlideAnalysis', 'SlideClassifier', 'SlideWorkflow', 'AiFeatures', 'Preference', 'PreferencePair', 'Benchmark', 'BenchmarkRun', 'RubricGrade', 'ReaderAnswer',
]);

const REQUIRED = {
  Observation: ['status', 'code'],
  Condition: ['subject'],
  AllergyIntolerance: ['patient'],
  MedicationRequest: ['status', 'intent', 'subject'],
  Encounter: ['status', 'class'],
  DocumentReference: ['status', 'content'],
  ServiceRequest: ['status', 'intent', 'subject'],
  DiagnosticReport: ['status', 'code'],
  ImagingStudy: ['status', 'subject'],
  Appointment: ['status', 'participant'],
  Communication: ['status'],
  Task: ['status', 'intent'],
  Provenance: ['target', 'recorded', 'agent'],
  List: ['status', 'mode'],
  AuditEvent: ['type', 'recorded', 'agent', 'source'],
  Run: ['umbrella', 'mode', 'branch', 'startedAt'],
  TraceStep: ['runId', 'saw', 'did', 'who', 'when'],
  DetectedIssue: ['status'],
  MedicationDispense: ['status'],
  MedicationAdministration: ['status', 'subject'],
  CarePlan: ['status', 'intent', 'subject'],
  Goal: ['lifecycleStatus', 'description', 'subject'],
  Procedure: ['status', 'subject'],
  Specimen: ['status', 'subject'],
};

const ID_PATTERN = /^[A-Za-z0-9\-.]{1,64}$/;

const present = (v) => v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== '';

export function validateResource(type, doc) {
  const issues = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['Resource must be a JSON object'];
  if (!FHIR_TYPES.has(type) && !INTERNAL_TYPES.has(type)) issues.push(`Unsupported resource type "${type}"`);
  if (doc.resourceType !== type) issues.push(`resourceType "${doc.resourceType}" does not match "${type}"`);
  if (doc.id !== undefined && !ID_PATTERN.test(String(doc.id))) issues.push(`Invalid id "${doc.id}"`);
  for (const field of REQUIRED[type] || []) {
    if (!present(doc[field])) issues.push(`${type}.${field} is required`);
  }
  if ((type === 'MedicationRequest' || type === 'MedicationDispense') && !present(doc.medicationCodeableConcept) && !present(doc.medicationReference)) {
    issues.push(`${type}.medication[x] is required`);
  }
  if (type === 'TraceStep') {
    if (!present(doc.saw?.branch)) issues.push('TraceStep.saw.branch is required');
    if (!present(doc.did?.type)) issues.push('TraceStep.did.type is required');
    if (!['agent', 'human'].includes(doc.who?.kind)) issues.push('TraceStep.who.kind must be agent or human');
    if (!present(doc.who?.id) || !present(doc.who?.role)) issues.push('TraceStep.who.id and who.role are required');
    if (!present(doc.when?.wall)) issues.push('TraceStep.when.wall is required');
    if (!('why' in doc)) issues.push('TraceStep.why must be present (null when not given)');
  }
  return issues;
}
