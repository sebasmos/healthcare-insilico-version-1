"""DICOM network gateway (docs/STANDARDS.md): a separate process that speaks DIMSE over TCP and forwards to the
platform over HTTPS, so the app itself stays HTTP-only.

Services: C-ECHO; C-STORE (to STOW-RS); C-FIND, C-MOVE and C-GET, patient and study root (from QIDO-RS and WADO);
modality worklist C-FIND (from scheduled imaging orders); MPPS N-CREATE and N-SET (Procedure records); storage
commitment N-ACTION with the N-EVENT-REPORT on the same association.

Environment: APP_URL (the app's base URL), DIMSE_GATEWAY_KEY (shared with the app), DIMSE_PORT (default 11112),
DIMSE_AE_TITLE (default HOSPITAL_DESK), DIMSE_AE_TABLE ("AE@host:port,AE2@host:port": C-MOVE destinations).
Licences: pynetdicom and pydicom are MIT.
"""
import io
import json
import logging
import os
import threading
import urllib.parse
import urllib.request
from pydicom import dcmread, Dataset
from pydicom.dataset import FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian
from pynetdicom import AE, evt, AllStoragePresentationContexts, StoragePresentationContexts
from pynetdicom.sop_class import (Verification, PatientRootQueryRetrieveInformationModelFind, StudyRootQueryRetrieveInformationModelFind,
                                  PatientRootQueryRetrieveInformationModelMove, StudyRootQueryRetrieveInformationModelMove,
                                  PatientRootQueryRetrieveInformationModelGet, StudyRootQueryRetrieveInformationModelGet,
                                  ModalityWorklistInformationFind, ModalityPerformedProcedureStep, StorageCommitmentPushModel)

APP = os.environ.get('APP_URL', 'http://127.0.0.1:8080').rstrip('/')
KEY = os.environ.get('DIMSE_GATEWAY_KEY', '')
AE_TABLE = {}
for item in filter(None, os.environ.get('DIMSE_AE_TABLE', '').split(',')):
    title, addr = item.split('@')
    host, port = addr.rsplit(':', 1)
    AE_TABLE[title.strip()] = (host, int(port))


def call(method, path, body=None, ctype='application/json', accept='application/json'):
    data = body if isinstance(body, (bytes, type(None))) else json.dumps(body).encode()
    req = urllib.request.Request(APP + path, data=data, method=method, headers={'Content-Type': ctype, 'Accept': accept, 'X-Gateway-Key': KEY})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, raw
    except urllib.error.HTTPError as e:
        body = e.read()
        logging.getLogger('gateway').warning('%s %s -> %s %s', method, path.split('?')[0], e.code, body[:300])
        return e.code, body


def as_json(raw):
    return json.loads(raw) if raw else []


def to_bytes(ds):
    buf = io.BytesIO()
    if not getattr(ds, 'file_meta', None) or 'TransferSyntaxUID' not in ds.file_meta:
        ds.file_meta = FileMetaDataset()
        ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
    ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.save_as(buf, write_like_original=False)
    return buf.getvalue()


def handle_store(event):
    ds = event.dataset
    ds.file_meta = event.file_meta
    boundary = 'dimse-gateway-boundary'
    body = (f'--{boundary}\r\nContent-Type: application/dicom\r\n\r\n').encode() + to_bytes(ds) + f'\r\n--{boundary}--\r\n'.encode()
    status, raw = call('POST', '/dicom-web/studies', body, ctype=f'multipart/related; type="application/dicom"; boundary={boundary}', accept='application/dicom+json')
    return 0x0000 if status in (200, 202) else 0xA700


def study_rows(identifier):
    q = {}
    for kw in ('PatientID', 'StudyInstanceUID', 'AccessionNumber', 'StudyDate', 'ModalitiesInStudy'):
        v = getattr(identifier, kw, None)
        if v not in (None, '', '*'):
            q[kw] = str(v)
    status, raw = call('GET', '/dicom-web/studies' + ('?' + urllib.parse.urlencode(q) if q else ''), accept='application/dicom+json')
    return [Dataset.from_json(r) for r in as_json(raw)] if status == 200 else []


def matches(identifier):
    level = getattr(identifier, 'QueryRetrieveLevel', 'STUDY')
    studies = study_rows(identifier)
    if level in ('STUDY', 'PATIENT'):
        return level, studies
    out = []
    for st in studies:
        uid = st.StudyInstanceUID
        status, raw = call('GET', f'/dicom-web/studies/{uid}/{"series" if level == "SERIES" else "instances"}', accept='application/dicom+json')
        for r in as_json(raw) if status == 200 else []:
            d = Dataset.from_json(r)
            if 'StudyInstanceUID' not in d:
                d.StudyInstanceUID = uid
            for kw in ('SeriesInstanceUID', 'SOPInstanceUID'):
                want = getattr(identifier, kw, None)
                if want not in (None, '', '*') and str(getattr(d, kw, '')) != str(want):
                    break
            else:
                out.append(d)
    return level, out


def handle_find(event):
    identifier = event.identifier
    if event.request.AffectedSOPClassUID == ModalityWorklistInformationFind:
        yield from worklist(identifier)
        return
    level, rows = matches(identifier)
    for d in rows:
        if event.is_cancelled:
            yield 0xFE00, None
            return
        d.QueryRetrieveLevel = level
        yield 0xFF00, d


def worklist(identifier):
    sps = identifier.ScheduledProcedureStepSequence[0] if 'ScheduledProcedureStepSequence' in identifier and len(identifier.ScheduledProcedureStepSequence) else Dataset()
    q = {}
    if getattr(sps, 'Modality', ''):
        q['modality'] = sps.Modality
    if getattr(sps, 'ScheduledProcedureStepStartDate', ''):
        q['date'] = sps.ScheduledProcedureStepStartDate
    status, raw = call('GET', '/api/dimse/worklist' + ('?' + urllib.parse.urlencode(q) if q else ''))
    for row in as_json(raw) if status == 200 else []:
        if getattr(identifier, 'PatientID', '') not in ('', '*', None) and identifier.PatientID != row['patientId']:
            continue
        d = Dataset()
        d.PatientName = 'MASKED'
        d.PatientID = row['patientId']
        d.PatientBirthDate = row['birthDate']
        d.PatientSex = row['sex']
        d.AccessionNumber = row['accession']
        d.StudyInstanceUID = row['studyInstanceUid']
        d.RequestedProcedureDescription = row['procedure']
        d.RequestedProcedureID = row['stepId']
        step = Dataset()
        step.Modality = row['modality']
        step.ScheduledStationAETitle = os.environ.get('DIMSE_AE_TITLE', 'HOSPITAL_DESK')
        step.ScheduledProcedureStepStartDate = row['date']
        step.ScheduledProcedureStepStartTime = row['time']
        step.ScheduledProcedureStepID = row['stepId']
        step.ScheduledProcedureStepDescription = row['procedure']
        d.ScheduledProcedureStepSequence = [step]
        yield 0xFF00, d


def instances_for(identifier):
    level, rows = matches(identifier)
    found = []
    for d in rows:
        if level == 'IMAGE':
            found.append((d.StudyInstanceUID, d.SeriesInstanceUID, d.SOPInstanceUID))
            continue
        status, raw = call('GET', f'/dicom-web/studies/{d.StudyInstanceUID}/instances', accept='application/dicom+json')
        for r in as_json(raw) if status == 200 else []:
            i = Dataset.from_json(r)
            if level == 'SERIES' and i.SeriesInstanceUID != d.SeriesInstanceUID:
                continue
            found.append((d.StudyInstanceUID, i.SeriesInstanceUID, i.SOPInstanceUID))
    return found


def fetch(study, series, sop):
    status, raw = call('GET', '/dicom-web/wado?' + urllib.parse.urlencode({'requestType': 'WADO', 'studyUID': study, 'seriesUID': series, 'objectUID': sop}), accept='application/dicom')
    return dcmread(io.BytesIO(raw)) if status == 200 else None


def handle_get(event):
    found = instances_for(event.identifier)
    yield len(found)
    for study, series, sop in found:
        if event.is_cancelled:
            yield 0xFE00, None
            return
        ds = fetch(study, series, sop)
        yield (0xFF00, ds) if ds is not None else (0xA701, None)


def handle_move(event):
    dest = AE_TABLE.get(event.move_destination.decode().strip() if isinstance(event.move_destination, bytes) else str(event.move_destination).strip())
    if not dest:
        yield None, None
        return
    found = instances_for(event.identifier)
    yield dest[0], dest[1]
    yield len(found)
    for study, series, sop in found:
        if event.is_cancelled:
            yield 0xFE00, None
            return
        ds = fetch(study, series, sop)
        yield (0xFF00, ds) if ds is not None else (0xA701, None)


MPPS = {}


def handle_n_create(event):
    if event.request.AffectedSOPClassUID != ModalityPerformedProcedureStep:
        return 0x0112, None
    ds = event.attribute_list
    uid = event.request.AffectedSOPInstanceUID
    sched = ds.ScheduledStepAttributesSequence[0] if 'ScheduledStepAttributesSequence' in ds and len(ds.ScheduledStepAttributesSequence) else Dataset()
    status, raw = call('POST', '/api/dimse/mpps', {'sopInstanceUid': uid, 'status': ds.PerformedProcedureStepStatus, 'accession': getattr(sched, 'AccessionNumber', '')})
    if status != 200:
        return 0x0110, None
    MPPS[uid] = ds
    return 0x0000, ds


def handle_n_set(event):
    uid = event.request.RequestedSOPInstanceUID
    mod = event.modification_list
    if uid not in MPPS:
        return 0x0112, None
    status, raw = call('POST', '/api/dimse/mpps', {'sopInstanceUid': uid, 'status': mod.PerformedProcedureStepStatus, 'series': [s.SeriesInstanceUID for s in getattr(mod, 'PerformedSeriesSequence', [])]})
    if status != 200:
        return 0x0110, None
    MPPS[uid].update(mod)
    return 0x0000, MPPS[uid]


def handle_n_action(event):
    info = event.action_information
    refs = [{'sopClass': r.ReferencedSOPClassUID, 'sopInstance': r.ReferencedSOPInstanceUID} for r in info.ReferencedSOPSequence]
    status, raw = call('POST', '/api/dimse/commitment', {'instances': refs})
    result = as_json(raw) if status == 200 else {'success': [], 'failed': refs}
    assoc = event.assoc
    txn = info.TransactionUID

    def report():
        reply = Dataset()
        reply.TransactionUID = txn
        reply.ReferencedSOPSequence = [ref_ds(x) for x in result['success']]
        if result['failed']:
            reply.FailedSOPSequence = [ref_ds(x, failed=True) for x in result['failed']]
        if assoc.is_established:
            assoc.send_n_event_report(reply, 2 if result['failed'] else 1, StorageCommitmentPushModel, '1.2.840.10008.1.20.1.1')
    threading.Timer(0.2, report).start()
    return 0x0000, None


def ref_ds(x, failed=False):
    d = Dataset()
    d.ReferencedSOPClassUID = x['sopClass']
    d.ReferencedSOPInstanceUID = x['sopInstance']
    if failed:
        d.FailureReason = 0x0112
    return d


def make_ae():
    ae = AE(ae_title=os.environ.get('DIMSE_AE_TITLE', 'HOSPITAL_DESK'))
    for c in AllStoragePresentationContexts:
        ae.add_supported_context(c.abstract_syntax, scu_role=True, scp_role=True)
    for c in (Verification, PatientRootQueryRetrieveInformationModelFind, StudyRootQueryRetrieveInformationModelFind, PatientRootQueryRetrieveInformationModelMove,
              StudyRootQueryRetrieveInformationModelMove, PatientRootQueryRetrieveInformationModelGet, StudyRootQueryRetrieveInformationModelGet,
              ModalityWorklistInformationFind, ModalityPerformedProcedureStep):
        ae.add_supported_context(c)
    ae.add_supported_context(StorageCommitmentPushModel, scu_role=True, scp_role=True)
    for c in StoragePresentationContexts:
        ae.add_requested_context(c.abstract_syntax)
    return ae


HANDLERS = [(evt.EVT_C_ECHO, lambda e: 0x0000), (evt.EVT_C_STORE, handle_store), (evt.EVT_C_FIND, handle_find), (evt.EVT_C_GET, handle_get),
            (evt.EVT_C_MOVE, handle_move), (evt.EVT_N_CREATE, handle_n_create), (evt.EVT_N_SET, handle_n_set), (evt.EVT_N_ACTION, handle_n_action)]

if __name__ == '__main__':
    logging.basicConfig(level=os.environ.get('DIMSE_LOG', 'WARNING'), format='%(levelname)s %(name)s %(message)s')
    if not KEY:
        raise SystemExit('Set DIMSE_GATEWAY_KEY (the same value the app has)')
    port = int(os.environ.get('DIMSE_PORT', '11112'))
    print(f'DIMSE gateway listening on {port}, forwarding to {APP}', flush=True)
    make_ae().start_server(('0.0.0.0', port), evt_handlers=HANDLERS, block=True)
