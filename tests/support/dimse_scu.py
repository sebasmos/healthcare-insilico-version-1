"""Test client for the DICOM gateway: runs every DIMSE service against it with pynetdicom and prints one JSON line.
argv: gateway port, move-destination port, patient id. The image is synthetic (8x8 pixels) and nameless."""
import json
import sys
import threading
import time
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage
from pynetdicom import AE, evt, build_role
from pynetdicom.sop_class import (Verification, StudyRootQueryRetrieveInformationModelFind, StudyRootQueryRetrieveInformationModelMove,
                                  StudyRootQueryRetrieveInformationModelGet, ModalityWorklistInformationFind, ModalityPerformedProcedureStep,
                                  StorageCommitmentPushModel)

port, dest_port, pid = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
out = {}


def image():
    ds = Dataset()
    ds.file_meta = FileMetaDataset()
    ds.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = generate_uid()
    ds.StudyInstanceUID = generate_uid()
    ds.SeriesInstanceUID = generate_uid()
    ds.PatientID = pid
    ds.PatientName = ''
    ds.Modality = 'CT'
    ds.StudyDate = '20261101'
    ds.SeriesNumber = 1
    ds.InstanceNumber = 1
    ds.Rows = 8
    ds.Columns = 8
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.PixelData = bytes(128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False
    return ds


received = []
dest = AE(ae_title='TEST_DEST')
dest.add_supported_context(CTImageStorage, ExplicitVRLittleEndian)
dest_server = dest.start_server(('127.0.0.1', dest_port), block=False, evt_handlers=[(evt.EVT_C_STORE, lambda e: (received.append(e.dataset.SOPInstanceUID), 0x0000)[1])])

ae = AE(ae_title='TEST_SCU')
for c in (Verification, StudyRootQueryRetrieveInformationModelFind, StudyRootQueryRetrieveInformationModelMove, StudyRootQueryRetrieveInformationModelGet, ModalityWorklistInformationFind, ModalityPerformedProcedureStep):
    ae.add_requested_context(c)
ae.add_requested_context(CTImageStorage, ExplicitVRLittleEndian)
ae.add_requested_context(StorageCommitmentPushModel)
got = []
reports = []
assoc = ae.associate('127.0.0.1', port, ae_title='HOSPITAL_DESK', ext_neg=[build_role(CTImageStorage, scu_role=True, scp_role=True), build_role(StorageCommitmentPushModel, scu_role=True, scp_role=True)],
                     evt_handlers=[(evt.EVT_C_STORE, lambda e: (got.append(e.dataset.SOPInstanceUID), 0x0000)[1]), (evt.EVT_N_EVENT_REPORT, lambda e: (reports.append((e.event_type, e.event_information)), (0x0000, None))[1])])
assert assoc.is_established, 'association refused'
out['echo'] = assoc.send_c_echo().Status
img = image()
out['store'] = assoc.send_c_store(img).Status

q = Dataset(); q.QueryRetrieveLevel = 'STUDY'; q.PatientID = pid; q.StudyInstanceUID = ''
out['find'] = [str(i.StudyInstanceUID) for s, i in assoc.send_c_find(q, StudyRootQueryRetrieveInformationModelFind) if s and s.Status == 0xFF00]
q2 = Dataset(); q2.QueryRetrieveLevel = 'STUDY'; q2.StudyInstanceUID = img.StudyInstanceUID
out['get'] = [s.Status for s, i in assoc.send_c_get(q2, StudyRootQueryRetrieveInformationModelGet)][-1]
out['got'] = list(map(str, got))
out['move'] = [s.Status for s, i in assoc.send_c_move(q2, 'TEST_DEST', StudyRootQueryRetrieveInformationModelMove)][-1]

wl = Dataset(); wl.PatientID = ''; wl.AccessionNumber = ''; sps = Dataset(); sps.Modality = 'CT'; sps.ScheduledProcedureStepStartDate = ''; wl.ScheduledProcedureStepSequence = [sps]
items = [i for s, i in assoc.send_c_find(wl, ModalityWorklistInformationFind) if s and s.Status == 0xFF00]
out['worklist'] = [{'patientId': str(i.PatientID), 'accession': str(i.AccessionNumber), 'name': str(i.PatientName)} for i in items]

mpps_uid = generate_uid()
c = Dataset(); c.PerformedProcedureStepStatus = 'IN PROGRESS'; s1 = Dataset(); s1.AccessionNumber = items[0].AccessionNumber if items else ''; s1.StudyInstanceUID = img.StudyInstanceUID; c.ScheduledStepAttributesSequence = [s1]
st, _ = assoc.send_n_create(c, ModalityPerformedProcedureStep, mpps_uid)
out['mpps_create'] = st.Status
m = Dataset(); m.PerformedProcedureStepStatus = 'COMPLETED'; ps = Dataset(); ps.SeriesInstanceUID = img.SeriesInstanceUID; m.PerformedSeriesSequence = [ps]
st, _ = assoc.send_n_set(m, ModalityPerformedProcedureStep, mpps_uid)
out['mpps_set'] = st.Status

a = Dataset(); a.TransactionUID = generate_uid()
r1 = Dataset(); r1.ReferencedSOPClassUID = CTImageStorage; r1.ReferencedSOPInstanceUID = img.SOPInstanceUID
r2 = Dataset(); r2.ReferencedSOPClassUID = CTImageStorage; r2.ReferencedSOPInstanceUID = generate_uid()
a.ReferencedSOPSequence = [r1, r2]
st, _ = assoc.send_n_action(a, 1, StorageCommitmentPushModel, '1.2.840.10008.1.20.1.1')
out['commit_action'] = st.Status
for _ in range(50):
    if reports:
        break
    time.sleep(0.1)
out['commit_report'] = [{'type': t, 'ok': [str(x.ReferencedSOPInstanceUID) for x in getattr(i, 'ReferencedSOPSequence', [])], 'failed': len(getattr(i, 'FailedSOPSequence', []))} for t, i in reports]
assoc.release()
time.sleep(0.3)
out['moved'] = list(map(str, received))
out['image'] = str(img.SOPInstanceUID)
dest_server.shutdown()
print(json.dumps(out))
