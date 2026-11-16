// Starter terminology catalogue: a small formulary (RxNorm ingredient codes),
// lab tests and panels (LOINC), imaging procedures (LOINC), problems
// (ICD-10-CM with SNOMED CT), allergy reactions (SNOMED CT) and vital signs.
// This is reference terminology, not patient data.
//
// UNVERIFIED STARTER SET. These codes were entered by hand and have not been
// checked against the official releases. To replace them with official codes:
//   LOINC (labs, panels, imaging, vitals, note types): https://loinc.org
//   RxNorm (medications): https://www.nlm.nih.gov/research/umls/rxnorm
// Keep the same object shapes and every app picks the new codes up.
export const SYSTEMS = {
  rxnorm: 'http://www.nlm.nih.gov/research/umls/rxnorm',
  loinc: 'http://loinc.org',
  icd10: 'http://hl7.org/fhir/sid/icd-10-cm',
  snomed: 'http://snomed.info/sct',
  drugClass: 'urn:hospital-desktop:drug-class',
  interpretation: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
  obsCategory: 'http://terminology.hl7.org/CodeSystem/observation-category',
};

// form: the dosage form the starter formulary stocks (see FORM_ROUTES). controlled: needs a second checker at dispense.
const FORM_BY_ROUTE = { oral: 'tablet', intravenous: 'injection', subcutaneous: 'injection', intramuscular: 'injection', inhaled: 'inhaler', topical: 'topical' };
const med = (code, name, classes, dose, unit, route, frequency, extra = {}) => ({ code, name, classes, dose, unit, route, frequency, form: FORM_BY_ROUTE[route] || 'other', ...extra });
export const MEDICATIONS = [
  med('723', 'Amoxicillin', ['penicillins'], 500, 'mg', 'oral', 'TID'),
  med('7984', 'Penicillin V', ['penicillins'], 500, 'mg', 'oral', 'QID'),
  med('2231', 'Cephalexin', ['cephalosporins'], 500, 'mg', 'oral', 'QID'),
  med('2193', 'Ceftriaxone', ['cephalosporins'], 1, 'g', 'intravenous', 'daily'),
  med('18631', 'Azithromycin', ['macrolides'], 500, 'mg', 'oral', 'daily'),
  med('2551', 'Ciprofloxacin', ['fluoroquinolones'], 500, 'mg', 'oral', 'BID'),
  med('82122', 'Levofloxacin', ['fluoroquinolones'], 750, 'mg', 'oral', 'daily'),
  med('10831', 'Sulfamethoxazole / Trimethoprim', ['sulfonamides'], 1, 'tablet', 'oral', 'BID'),
  med('11124', 'Vancomycin', ['glycopeptides'], 1, 'g', 'intravenous', 'BID'),
  med('29046', 'Lisinopril', ['ace-inhibitors'], 10, 'mg', 'oral', 'daily'),
  med('52175', 'Losartan', ['arbs'], 50, 'mg', 'oral', 'daily'),
  med('17767', 'Amlodipine', ['calcium-channel-blockers'], 5, 'mg', 'oral', 'daily'),
  med('6918', 'Metoprolol', ['beta-blockers'], 25, 'mg', 'oral', 'BID'),
  med('5487', 'Hydrochlorothiazide', ['thiazides', 'sulfonamides'], 25, 'mg', 'oral', 'daily'),
  med('4603', 'Furosemide', ['loop-diuretics'], 40, 'mg', 'oral', 'daily'),
  med('83367', 'Atorvastatin', ['statins'], 40, 'mg', 'oral', 'nightly'),
  med('36567', 'Simvastatin', ['statins'], 20, 'mg', 'oral', 'nightly'),
  med('6809', 'Metformin', ['biguanides'], 500, 'mg', 'oral', 'BID'),
  med('274783', 'Insulin glargine', ['insulins'], 10, 'units', 'subcutaneous', 'nightly', { highAlert: true }),
  med('86009', 'Insulin lispro', ['insulins'], 4, 'units', 'subcutaneous', 'TID', { highAlert: true }),
  med('1191', 'Aspirin', ['nsaids', 'salicylates'], 81, 'mg', 'oral', 'daily'),
  med('5640', 'Ibuprofen', ['nsaids'], 400, 'mg', 'oral', 'TID'),
  med('7258', 'Naproxen', ['nsaids'], 500, 'mg', 'oral', 'BID'),
  med('35827', 'Ketorolac', ['nsaids'], 15, 'mg', 'intravenous', 'Q6H'),
  med('161', 'Acetaminophen', ['analgesics'], 650, 'mg', 'oral', 'Q6H'),
  med('7052', 'Morphine', ['opioids'], 2, 'mg', 'intravenous', 'Q4H', { controlled: true, highAlert: true }),
  med('7804', 'Oxycodone', ['opioids'], 5, 'mg', 'oral', 'Q6H', { controlled: true, highAlert: true }),
  med('2670', 'Codeine', ['opioids'], 30, 'mg', 'oral', 'Q6H'),
  med('11289', 'Warfarin', ['anticoagulants'], 5, 'mg', 'oral', 'daily'),
  med('5224', 'Heparin', ['anticoagulants'], 5000, 'units', 'subcutaneous', 'TID', { highAlert: true }),
  med('67108', 'Enoxaparin', ['anticoagulants'], 40, 'mg', 'subcutaneous', 'daily'),
  med('32968', 'Clopidogrel', ['antiplatelets'], 75, 'mg', 'oral', 'daily'),
  med('435', 'Albuterol', ['beta-agonists'], 2, 'puffs', 'inhaled', 'Q4H'),
  med('8640', 'Prednisone', ['corticosteroids'], 40, 'mg', 'oral', 'daily'),
  med('7646', 'Omeprazole', ['proton-pump-inhibitors'], 20, 'mg', 'oral', 'daily'),
  med('40790', 'Pantoprazole', ['proton-pump-inhibitors'], 40, 'mg', 'oral', 'daily'),
  med('26225', 'Ondansetron', ['antiemetics'], 4, 'mg', 'oral', 'Q8H'),
  med('25480', 'Gabapentin', ['anticonvulsants'], 300, 'mg', 'oral', 'TID'),
  med('36437', 'Sertraline', ['ssris'], 50, 'mg', 'oral', 'daily'),
  med('10582', 'Levothyroxine', ['thyroid-hormones'], 50, 'mcg', 'oral', 'daily'),
  med('8591', 'Potassium chloride', ['electrolytes'], 20, 'mEq', 'oral', 'daily', { highAlert: true }),
  med('3423', 'Hydromorphone', ['opioids'], 0.5, 'mg', 'intravenous', 'Q4H', { controlled: true, highAlert: true }),
  med('4337', 'Fentanyl', ['opioids'], 25, 'mcg', 'intravenous', 'once', { controlled: true, highAlert: true }),
  med('6960', 'Midazolam', ['benzodiazepines'], 1, 'mg', 'intravenous', 'once', { controlled: true }),
  med('6470', 'Lorazepam', ['benzodiazepines'], 0.5, 'mg', 'oral', 'Q8H', { controlled: true }),
];
// highAlert: needs a second nurse as witness at administration: insulins, heparin, opioids, potassium chloride.
export const isHighAlert = (code) => Boolean(MEDICATIONS.find((m) => m.code === code)?.highAlert);
export const isControlled = (code) => Boolean(MEDICATIONS.find((m) => m.code === code)?.controlled);

// ---------- Pharmacy verification tables ----------
// Small starter set, not clinical reference. UNVERIFIED: entered by hand for the simulation only,
// never checked against a drug information source. Do not present these as clinical reference.
// An interaction pair names each side by RxNorm ingredient code ({ code }) or by catalogue drug class ({ class }).
export const INTERACTIONS = {
  unverified: true,
  pairs: [
    { a: { code: '11289', name: 'Warfarin' }, b: { code: '1191', name: 'Aspirin' }, severity: 'high', detail: 'Additive bleeding risk' },
    { a: { code: '11289', name: 'Warfarin' }, b: { class: 'nsaids', name: 'NSAIDs' }, severity: 'high', detail: 'Bleeding risk and gastric injury' },
    { a: { code: '11289', name: 'Warfarin' }, b: { code: '4450', name: 'Fluconazole' }, severity: 'high', detail: 'Warfarin levels rise (CYP2C9 inhibition)' },
    { a: { code: '6851', name: 'Methotrexate' }, b: { code: '10831', name: 'Sulfamethoxazole / Trimethoprim' }, severity: 'high', detail: 'Bone marrow suppression' },
    { a: { code: '8591', name: 'Potassium chloride' }, b: { code: '9997', name: 'Spironolactone' }, severity: 'high', detail: 'Hyperkalaemia' },
    { a: { code: '8591', name: 'Potassium chloride' }, b: { class: 'ace-inhibitors', name: 'ACE inhibitors' }, severity: 'moderate', detail: 'Hyperkalaemia; check potassium' },
    { a: { code: '36567', name: 'Simvastatin' }, b: { code: '21212', name: 'Clarithromycin' }, severity: 'high', detail: 'Myopathy risk (CYP3A4 inhibition)' },
    { a: { code: '6448', name: 'Lithium' }, b: { class: 'nsaids', name: 'NSAIDs' }, severity: 'moderate', detail: 'Lithium levels rise' },
    { a: { code: '136411', name: 'Sildenafil' }, b: { class: 'nitrates', name: 'Nitrates' }, severity: 'high', detail: 'Severe hypotension' },
    { a: { class: 'ssris', name: 'SSRIs' }, b: { code: '10689', name: 'Tramadol' }, severity: 'moderate', detail: 'Serotonin syndrome and seizure risk' },
    { a: { code: '3407', name: 'Digoxin' }, b: { code: '703', name: 'Amiodarone' }, severity: 'high', detail: 'Digoxin levels rise' },
    { a: { code: '32968', name: 'Clopidogrel' }, b: { code: '7646', name: 'Omeprazole' }, severity: 'moderate', detail: 'Reduced antiplatelet effect' },
    { a: { class: 'ace-inhibitors', name: 'ACE inhibitors' }, b: { class: 'arbs', name: 'ARBs' }, severity: 'moderate', detail: 'Dual RAAS blockade: hypotension, hyperkalaemia, renal injury' },
  ],
};

// Per RxNorm code, in mg (units, mEq, mcg stated per entry): maximum single dose, maximum daily dose,
// per-kilogram limits where sensible, and a renal flag with the eGFR threshold below which the dose needs review.
export const DOSE_RANGES = {
  unverified: true,
  byCode: {
    161: { name: 'Acetaminophen', unit: 'mg', maxSingle: 1000, maxDaily: 4000 },
    5640: { name: 'Ibuprofen', unit: 'mg', maxSingle: 800, maxDaily: 3200, renal: { egfrBelow: 30, note: 'avoid in severe renal impairment' } },
    7052: { name: 'Morphine', unit: 'mg', maxSingle: 10, maxDaily: 60, renal: { egfrBelow: 30, note: 'metabolites accumulate' } },
    7804: { name: 'Oxycodone', unit: 'mg', maxSingle: 30, maxDaily: 120, renal: { egfrBelow: 30, note: 'reduce dose' } },
    723: { name: 'Amoxicillin', unit: 'mg', maxSingle: 1000, maxDaily: 3000, renal: { egfrBelow: 30, note: 'extend the interval' } },
    2193: { name: 'Ceftriaxone', unit: 'mg', maxSingle: 2000, maxDaily: 4000 },
    11124: { name: 'Vancomycin', unit: 'mg', maxSingle: 2000, maxDaily: 4000, perKgSingle: 20, renal: { egfrBelow: 50, note: 'dose by levels' } },
    67108: { name: 'Enoxaparin', unit: 'mg', maxSingle: 150, maxDaily: 300, perKgSingle: 1.5, renal: { egfrBelow: 30, note: 'reduce to once daily' } },
    6809: { name: 'Metformin', unit: 'mg', maxSingle: 1000, maxDaily: 2000, renal: { egfrBelow: 30, note: 'contraindicated; review below 45' } },
    8591: { name: 'Potassium chloride', unit: 'mEq', maxSingle: 40, maxDaily: 100, renal: { egfrBelow: 30, note: 'hyperkalaemia risk' } },
    25480: { name: 'Gabapentin', unit: 'mg', maxSingle: 1200, maxDaily: 3600, renal: { egfrBelow: 60, note: 'reduce dose' } },
    29046: { name: 'Lisinopril', unit: 'mg', maxSingle: 40, maxDaily: 80, renal: { egfrBelow: 30, note: 'start low' } },
  },
};

// Which routes are valid for each dosage form stocked in the starter formulary.
export const FORM_ROUTES = {
  unverified: true,
  byForm: {
    tablet: ['oral'], capsule: ['oral'], liquid: ['oral'], injection: ['intravenous', 'subcutaneous', 'intramuscular'],
    inhaler: ['inhaled'], topical: ['topical'], other: Object.keys({ oral: 1, intravenous: 1, subcutaneous: 1, intramuscular: 1, inhaled: 1, topical: 1 }),
  },
};

// Doses per day for each frequency code, used by the daily-dose check. PRN has no fixed count.
export const DOSES_PER_DAY = { daily: 1, BID: 2, TID: 3, QID: 4, nightly: 1, Q4H: 6, Q6H: 4, Q8H: 3, once: 1, PRN: null };

// Classes where an allergy to one member is treated as a conflict for all.
export const CROSS_REACTIVE_CLASSES = ['penicillins', 'cephalosporins', 'sulfonamides', 'nsaids', 'opioids', 'fluoroquinolones', 'macrolides', 'statins', 'ace-inhibitors'];
export const DRUG_CLASSES = Object.fromEntries(CROSS_REACTIVE_CLASSES.map((c) => [c, c.replace(/-/g, ' ').replace(/^\w/, (m) => m.toUpperCase())]));

export const FREQUENCIES = {
  daily: 'once daily', BID: 'twice daily', TID: 'three times daily', QID: 'four times daily', nightly: 'at bedtime',
  Q4H: 'every 4 hours', Q6H: 'every 6 hours', Q8H: 'every 8 hours', PRN: 'as needed', once: 'once',
};
export const ROUTES = { oral: 'by mouth', intravenous: 'intravenously', subcutaneous: 'subcutaneously', intramuscular: 'intramuscularly', inhaled: 'by inhalation', topical: 'topically' };

const lab = (code, name, unit, low, high, critLow = null, critHigh = null) => ({ code, name, unit, low, high, critLow, critHigh });
export const LABS = [
  lab('2345-7', 'Glucose', 'mg/dL', 70, 99, 50, 400),
  lab('3094-0', 'Urea nitrogen (BUN)', 'mg/dL', 7, 20, null, 100),
  lab('2160-0', 'Creatinine', 'mg/dL', 0.6, 1.3, null, 5),
  lab('2951-2', 'Sodium', 'mmol/L', 136, 145, 120, 160),
  lab('2823-3', 'Potassium', 'mmol/L', 3.5, 5.1, 2.8, 6.2),
  lab('2075-0', 'Chloride', 'mmol/L', 98, 107, 80, 120),
  lab('2028-9', 'Carbon dioxide', 'mmol/L', 22, 29, 10, 40),
  lab('17861-6', 'Calcium', 'mg/dL', 8.6, 10.3, 6.5, 13),
  lab('2885-2', 'Total protein', 'g/dL', 6.0, 8.3),
  lab('1751-7', 'Albumin', 'g/dL', 3.5, 5.2),
  lab('1975-2', 'Bilirubin, total', 'mg/dL', 0.1, 1.2, null, 15),
  lab('6768-6', 'Alkaline phosphatase', 'U/L', 44, 147),
  lab('1920-8', 'AST', 'U/L', 10, 40),
  lab('1742-6', 'ALT', 'U/L', 7, 56),
  lab('6690-2', 'White blood cells', '10*3/uL', 4.5, 11.0, 2.0, 30),
  lab('789-8', 'Red blood cells', '10*6/uL', 4.2, 5.9),
  lab('718-7', 'Hemoglobin', 'g/dL', 12.0, 17.5, 7.0, 20),
  lab('4544-3', 'Hematocrit', '%', 36, 52, 20, 60),
  lab('787-2', 'MCV', 'fL', 80, 100),
  lab('777-3', 'Platelets', '10*3/uL', 150, 450, 20, 1000),
  lab('2093-3', 'Cholesterol, total', 'mg/dL', 0, 199),
  lab('2571-8', 'Triglycerides', 'mg/dL', 0, 149),
  lab('2085-9', 'HDL cholesterol', 'mg/dL', 40, 100),
  lab('13457-7', 'LDL cholesterol (calculated)', 'mg/dL', 0, 99),
  lab('10839-9', 'Troponin I', 'ng/mL', 0, 0.04, null, 0.4),
  lab('2524-7', 'Lactate', 'mmol/L', 0.5, 2.2, null, 4),
  lab('4548-4', 'Hemoglobin A1c', '%', 4.0, 5.6),
  lab('3016-3', 'TSH', 'mIU/L', 0.4, 4.0),
  lab('6301-6', 'INR', '{ratio}', 0.8, 1.2, null, 5),
  lab('30934-4', 'BNP', 'pg/mL', 0, 100),
  lab('48065-7', 'D-dimer', 'ug/mL{FEU}', 0, 0.5),
];

export const PANELS = [
  { code: '24323-8', name: 'Comprehensive metabolic panel (CMP)', short: 'CMP', components: ['2345-7', '3094-0', '2160-0', '2951-2', '2823-3', '2075-0', '2028-9', '17861-6', '2885-2', '1751-7', '1975-2', '6768-6', '1920-8', '1742-6'] },
  { code: '58410-2', name: 'Complete blood count (CBC)', short: 'CBC', components: ['6690-2', '789-8', '718-7', '4544-3', '787-2', '777-3'] },
  { code: '57698-3', name: 'Lipid panel', short: 'Lipid', components: ['2093-3', '2571-8', '2085-9', '13457-7'] },
];

export const IMAGING = [
  { code: '36643-5', name: 'XR Chest 2 views', modality: 'DX', bodySite: 'Chest' },
  { code: '36554-4', name: 'XR Chest single view', modality: 'DX', bodySite: 'Chest' },
  { code: '24725-4', name: 'CT Head', modality: 'CT', bodySite: 'Head' },
  { code: '24627-2', name: 'CT Chest', modality: 'CT', bodySite: 'Chest' },
  { code: '44115-4', name: 'CT Abdomen and pelvis', modality: 'CT', bodySite: 'Abdomen' },
  { code: '24590-2', name: 'MR Brain', modality: 'MR', bodySite: 'Head' },
  { code: '24558-9', name: 'US Abdomen', modality: 'US', bodySite: 'Abdomen' },
  { code: '39046-8', name: 'US Lower extremity veins', modality: 'US', bodySite: 'Leg' },
];

const dx = (code, name, snomed) => ({ code, name, snomed });
// Procedures orderable from the chart that are neither labs nor imaging.
// Pathology orders. LOINC codes unverified against the current release.
export const PATHOLOGY = [
  { code: '11529-5', name: 'Surgical pathology', specimen: 'Biopsy' },
  { code: '47527-7', name: 'Cytology, non-gynaecological', specimen: 'Cytology' },
];
export const PROCEDURES = [
  { code: '11524-6', name: '12-lead ECG', category: 'ecg' },
];

export const PROBLEMS = [
  dx('I10', 'Essential (primary) hypertension', '59621000'),
  dx('E11.9', 'Type 2 diabetes mellitus without complications', '44054006'),
  dx('E10.10', 'Type 1 diabetes mellitus with ketoacidosis without coma', '420422005'),
  dx('E78.5', 'Hyperlipidemia, unspecified', '55822004'),
  dx('J18.9', 'Pneumonia, unspecified organism', '233604007'),
  dx('J45.909', 'Unspecified asthma, uncomplicated', '195967001'),
  dx('J44.9', 'Chronic obstructive pulmonary disease, unspecified', '13645005'),
  dx('I26.99', 'Other pulmonary embolism without acute cor pulmonale', '59282003'),
  dx('I21.3', 'ST elevation (STEMI) myocardial infarction of unspecified site', '401303003'),
  dx('I48.91', 'Unspecified atrial fibrillation', '49436004'),
  dx('I50.9', 'Heart failure, unspecified', '84114007'),
  dx('N17.9', 'Acute kidney failure, unspecified', '14669001'),
  dx('N18.30', 'Chronic kidney disease, stage 3 unspecified', '433144002'),
  dx('E87.5', 'Hyperkalemia', '14140009'),
  dx('K92.2', 'Gastrointestinal hemorrhage, unspecified', '74474003'),
  dx('K21.9', 'Gastro-esophageal reflux disease without esophagitis', '235595009'),
  dx('A41.9', 'Sepsis, unspecified organism', '91302008'),
  dx('R07.9', 'Chest pain, unspecified', '29857009'),
  dx('M54.50', 'Low back pain, unspecified', '279039007'),
  dx('F32.A', 'Depression, unspecified', '35489007'),
];

export const REACTIONS = [
  { code: '39579001', name: 'Anaphylaxis' }, { code: '126485001', name: 'Urticaria (hives)' },
  { code: '271807003', name: 'Rash' }, { code: '41291007', name: 'Angioedema' },
  { code: '422587007', name: 'Nausea' }, { code: '267036007', name: 'Shortness of breath' },
  { code: '418290006', name: 'Itching' },
];
export const NO_KNOWN_ALLERGY = { system: SYSTEMS.snomed, code: '716186003', display: 'No known allergy' };
export const OTHER_ALLERGENS = [
  { system: SYSTEMS.snomed, code: '91935009', name: 'Peanut', category: 'food' },
  { system: SYSTEMS.snomed, code: '300913006', name: 'Shellfish', category: 'food' },
  { system: SYSTEMS.snomed, code: '1003755004', name: 'Latex', category: 'environment' },
  { system: SYSTEMS.snomed, code: '293637006', name: 'Iodinated contrast media', category: 'medication' },
];

const vital = (key, code, name, unit, low, high) => ({ key, code, name, unit, low, high });
export const VITALS = [
  vital('hr', '8867-4', 'Heart rate', '/min', 60, 100),
  vital('rr', '9279-1', 'Respiratory rate', '/min', 12, 20),
  vital('sbp', '8480-6', 'Systolic blood pressure', 'mm[Hg]', 90, 139),
  vital('dbp', '8462-4', 'Diastolic blood pressure', 'mm[Hg]', 60, 89),
  vital('temp', '8310-5', 'Body temperature', 'Cel', 36.1, 37.9),
  vital('spo2', '59408-5', 'Oxygen saturation (SpO2)', '%', 94, 100),
  vital('weight', '29463-7', 'Body weight', 'kg', null, null),
  vital('height', '8302-2', 'Body height', 'cm', null, null),
  vital('bmi', '39156-5', 'Body mass index', 'kg/m2', 18.5, 24.9),
];

export const NOTE_TYPES = [
  { code: '34117-2', name: 'History and physical' }, { code: '11506-3', name: 'Progress note' },
  { code: '18842-5', name: 'Discharge summary' }, { code: '28570-0', name: 'Procedure note' },
  { code: '11488-4', name: 'Consult note' }, { code: '34111-5', name: 'Emergency department note' },
  { code: '34746-8', name: 'Nursing note', nursing: true },
];
export const NURSING_NOTE_CODES = ['34746-8'];

// Nursing assessments recorded on the flowsheet beside the vitals. LOINC where a code is known,
// otherwise a local code; an unverified starter set like the rest of this catalogue.
export const ASSESSMENT_SYSTEM = 'urn:hospital-desktop:assessment';
export const ASSESSMENTS = [
  { key: 'pain', code: '72514-3', system: SYSTEMS.loinc, name: 'Pain score (0 to 10)', kind: 'number', unit: '{score}', min: 0, max: 10 },
  { key: 'consciousness', code: 'acvpu', system: ASSESSMENT_SYSTEM, name: 'Consciousness (ACVPU)', kind: 'choice', options: ['A', 'C', 'V', 'P', 'U'] },
  { key: 'o2device', code: 'o2-device', system: ASSESSMENT_SYSTEM, name: 'Oxygen device', kind: 'choice', options: ['Room air', 'Nasal cannula', 'Simple mask', 'Venturi mask', 'Non-rebreather', 'High-flow nasal', 'NIV'] },
  { key: 'o2flow', code: '3151-8', system: SYSTEMS.loinc, name: 'Oxygen flow (L/min)', kind: 'number', unit: 'L/min', min: 0, max: 60 },
  { key: 'fallrisk', code: 'fall-risk', system: ASSESSMENT_SYSTEM, name: 'Fall risk (0 to 20)', kind: 'number', unit: '{score}', min: 0, max: 20 },
  { key: 'skin', code: 'skin', system: ASSESSMENT_SYSTEM, name: 'Skin', kind: 'choice', options: ['Intact', 'Redness', 'Blister', 'Open wound', 'Pressure injury'] },
];
export const ASSESSMENT_BY_CODE = new Map(ASSESSMENTS.map((a) => [a.code, a]));

// Intake and output items. Volumes in mL; category intake-output.
export const IO_SYSTEM = 'urn:hospital-desktop:intake-output';
export const IO_ITEMS = [
  { code: 'oral', name: 'Oral', direction: 'in' }, { code: 'iv', name: 'IV', direction: 'in' }, { code: 'tube', name: 'Tube feed', direction: 'in' },
  { code: 'urine', name: 'Urine', direction: 'out' }, { code: 'drain', name: 'Drain', direction: 'out' }, { code: 'emesis', name: 'Emesis', direction: 'out' }, { code: 'stool', name: 'Stool', direction: 'out' },
];
export const EDUCATION_TOPICS = ['Medication use', 'Wound care', 'Diet', 'Activity and falls', 'Device use', 'Discharge plan', 'Disease process', 'Pain management'];
export const EDUCATION_METHODS = ['Explanation', 'Demonstration', 'Written material', 'Video', 'Teach-back'];
export const UNDERSTANDING = ['Verbalised understanding', 'Return demonstration', 'Needs reinforcement', 'Unable to assess'];

export const byCode = (list) => new Map(list.map((x) => [x.code, x]));
export const LAB_BY_CODE = byCode(LABS);
export const VITAL_BY_CODE = byCode(VITALS);
export const MED_BY_CODE = byCode(MEDICATIONS);

export function catalog() {
  return {
    procedures: PROCEDURES, pathology: PATHOLOGY, assessments: ASSESSMENTS, ioItems: IO_ITEMS, educationTopics: EDUCATION_TOPICS, educationMethods: EDUCATION_METHODS, understanding: UNDERSTANDING, highAlert: MEDICATIONS.filter((m) => m.highAlert).map((m) => m.code),
    verified: false,
    sources: { loinc: 'https://loinc.org', rxnorm: 'https://www.nlm.nih.gov/research/umls/rxnorm' },
    systems: SYSTEMS, medications: MEDICATIONS, drugClasses: DRUG_CLASSES, frequencies: FREQUENCIES, routes: ROUTES,
    labs: LABS, panels: PANELS, imaging: IMAGING, problems: PROBLEMS, reactions: REACTIONS,
    otherAllergens: OTHER_ALLERGENS, noKnownAllergy: NO_KNOWN_ALLERGY, vitals: VITALS, noteTypes: NOTE_TYPES,
    // Pharmacy starter tables: small, hand-entered, unverified; shown as such.
    interactions: INTERACTIONS, doseRanges: DOSE_RANGES, formRoutes: FORM_ROUTES, dosesPerDay: DOSES_PER_DAY,
  };
}

/** N / L / H / LL / HH from a value and a range with optional critical bounds. */
export function interpret(value, { low, high, critLow = null, critHigh = null }) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (critLow != null && value < critLow) return 'LL';
  if (critHigh != null && value > critHigh) return 'HH';
  if (low != null && value < low) return 'L';
  if (high != null && value > high) return 'H';
  return 'N';
}
