import { AnchorStatus, StreamUtils, IpfsApi, SignatureStatus } from '@ceramicnetwork/common';
import CID from 'cids';
import { RunningState } from '../state-management/running-state';
import { createIPFS } from './ipfs-util';
import { createCeramic } from './create-ceramic';
import Ceramic from '../ceramic';
import { anchorUpdate } from '../state-management/__tests__/anchor-update';
import { TileDocument } from '@ceramicnetwork/stream-tile';
import { streamFromState } from '../state-management/stream-from-state';

const FAKE_CID = new CID('bafybeig6xv5nwphfmvcnektpnojts33jqcuam7bmye2pb54adnrtccjlsu');
const INITIAL_CONTENT = { abc: 123, def: 456 };
const STRING_MAP_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'StringMap',
  type: 'object',
  additionalProperties: {
    type: 'string',
  },
};

let ipfs: IpfsApi;
let ceramic: Ceramic;
let controllers: string[];

beforeAll(async () => {
  ipfs = await createIPFS();
  ceramic = await createCeramic(ipfs, { anchorOnRequest: true });

  controllers = [ceramic.did.id];
});

afterAll(async () => {
  await ceramic.close();
  await ipfs.stop();
});

describe('anchor', () => {
  test('anchor call', async () => {
    const stream = await TileDocument.create(ceramic, INITIAL_CONTENT);
    const stream$ = await ceramic.repository.load(stream.id, {});
    await new Promise((resolve) => {
      ceramic.repository.stateManager.anchor(stream$).add(resolve);
    });
    expect(stream$.value.anchorStatus).toEqual(AnchorStatus.ANCHORED);
  });
});

test('handleTip', async () => {
  const stream1 = await TileDocument.create(ceramic, INITIAL_CONTENT, null, { anchor:false });
  stream1.subscribe();
  const streamState1 = await ceramic.repository.load(stream1.id, {});
  await new Promise((resolve) => {
    ceramic.repository.stateManager.anchor(streamState1).add(resolve);
  });


  const ceramic2 = await createCeramic(ipfs);
  const stream2 = await ceramic2.loadStream<TileDocument>(stream1.id, { syncTimeoutSeconds:0 });
  stream2.subscribe();
  const streamState2 = await ceramic2.repository.load(stream2.id, {});

  expect(stream2.content).toEqual(stream1.content);
  expect(stream2.state).toEqual(expect.objectContaining({ signature: SignatureStatus.SIGNED, anchorStatus: 0 }));

  await (ceramic2.repository.stateManager as any)._handleTip(streamState2, stream1.state.log[1].cid);

  expect(stream2.state).toEqual(stream1.state);
  await ceramic2.close();
});

test('commit history and rewind', async () => {
  const stream = await TileDocument.create<any>(ceramic, INITIAL_CONTENT);
  stream.subscribe();
  const streamState = await ceramic.repository.load(stream.id, {});

  const commit0 = stream.allCommitIds[0];
  expect(stream.commitId).toEqual(commit0);
  expect(commit0.equals(streamState.id.atCommit(streamState.id.cid))).toBeTruthy();

  await anchorUpdate(ceramic, stream);
  expect(stream.allCommitIds.length).toEqual(2);
  expect(stream.anchorCommitIds.length).toEqual(1);
  const commit1 = stream.allCommitIds[1];
  expect(commit1.equals(commit0)).toBeFalsy();
  expect(commit1).toEqual(stream.commitId);
  expect(commit1).toEqual(stream.anchorCommitIds[0]);

  const newContent = { abc: 321, def: 456, gh: 987 };
  const updateRec = await stream.makeCommit(ceramic, newContent)
  await ceramic.repository.stateManager.applyCommit(streamState.id, updateRec, { anchor: true, publish: false });
  expect(stream.allCommitIds.length).toEqual(3);
  expect(stream.anchorCommitIds.length).toEqual(1);
  const commit2 = stream.allCommitIds[2];
  expect(commit2.equals(commit1)).toBeFalsy();
  expect(commit2).toEqual(stream.commitId);

  await anchorUpdate(ceramic, stream);
  expect(stream.allCommitIds.length).toEqual(4);
  expect(stream.anchorCommitIds.length).toEqual(2);
  const commit3 = stream.allCommitIds[3];
  expect(commit3.equals(commit2)).toBeFalsy();
  expect(commit3).toEqual(stream.commitId);
  expect(commit3).toEqual(stream.anchorCommitIds[1]);
  expect(stream.content).toEqual(newContent);
  expect(stream.state.signature).toEqual(SignatureStatus.SIGNED);
  expect(stream.state.anchorStatus).not.toEqual(AnchorStatus.NOT_REQUESTED);
  expect(stream.state.log.length).toEqual(4);

  // Apply a final record that does not get anchored
  const finalContent = { foo: 'bar' };
  const updateRec2 = await stream.makeCommit(ceramic, finalContent)
  await ceramic.repository.stateManager.applyCommit(streamState.id, updateRec2, { anchor: true, publish: false });

  expect(stream.allCommitIds.length).toEqual(5);
  expect(stream.anchorCommitIds.length).toEqual(2);
  const commit4 = stream.allCommitIds[4];
  expect(commit4.equals(commit3)).toBeFalsy();
  expect(commit4).toEqual(stream.commitId);
  expect(commit4.equals(stream.anchorCommitIds[1])).toBeFalsy();
  expect(stream.state.log.length).toEqual(5);

  // Correctly check out a specific commit
  const streamV0 = await ceramic.repository.stateManager.rewind(streamState, commit0);
  expect(streamV0.id.equals(commit0.baseID)).toBeTruthy();
  expect(streamV0.value.log.length).toEqual(1);
  expect(streamV0.value.metadata.controllers).toEqual(controllers);
  expect(streamV0.value.content).toEqual(INITIAL_CONTENT);
  expect(streamV0.value.anchorStatus).toEqual(AnchorStatus.NOT_REQUESTED);

  const streamV1 = await ceramic.repository.stateManager.rewind(streamState, commit1);
  expect(streamV1.id.equals(commit1.baseID)).toBeTruthy();
  expect(streamV1.value.log.length).toEqual(2);
  expect(streamV1.value.metadata.controllers).toEqual(controllers);
  expect(streamV1.value.content).toEqual(INITIAL_CONTENT);
  expect(streamV1.value.anchorStatus).toEqual(AnchorStatus.ANCHORED);

  const streamV2 = await ceramic.repository.stateManager.rewind(streamState, commit2);
  expect(streamV2.id.equals(commit2.baseID)).toBeTruthy();
  expect(streamV2.value.log.length).toEqual(3);
  expect(streamV2.value.metadata.controllers).toEqual(controllers);
  expect(streamV2.value.next.content).toEqual(newContent);
  expect(streamV2.value.anchorStatus).toEqual(AnchorStatus.NOT_REQUESTED);

  const streamV3 = await ceramic.repository.stateManager.rewind(streamState, commit3);
  expect(streamV3.id.equals(commit3.baseID)).toBeTruthy();
  expect(streamV3.value.log.length).toEqual(4);
  expect(streamV3.value.metadata.controllers).toEqual(controllers);
  expect(streamV3.value.content).toEqual(newContent);
  expect(streamV3.value.anchorStatus).toEqual(AnchorStatus.ANCHORED);

  const streamV4 = await ceramic.repository.stateManager.rewind(streamState, commit4);
  expect(streamV4.id.equals(commit4.baseID)).toBeTruthy();
  expect(streamV4.value.log.length).toEqual(5);
  expect(streamV4.value.metadata.controllers).toEqual(controllers);
  expect(streamV4.value.next.content).toEqual(finalContent);
  expect(streamV4.value.anchorStatus).toEqual(AnchorStatus.NOT_REQUESTED);
});

describe('rewind', () => {
  test('non-existing commit', async () => {
    const stream = await TileDocument.create(ceramic, INITIAL_CONTENT);
    const streamState = await ceramic.repository.load(stream.id, {});
    // Emulate loading a non-existing commit
    const nonExistentCommitID = stream.id.atCommit(FAKE_CID);
    const originalRetrieve = ceramic.dispatcher.retrieveCommit.bind(ceramic.dispatcher);
    ceramic.dispatcher.retrieveCommit = jest.fn(async (cid: CID) => {
      if (cid.equals(FAKE_CID)) {
        return null;
      } else {
        return originalRetrieve(cid);
      }
    });
    await expect(ceramic.repository.stateManager.rewind(streamState, nonExistentCommitID)).rejects.toThrow(
      `No commit found for CID ${nonExistentCommitID.commit?.toString()}`,
    );
  });

  test('return read-only snapshot', async () => {
    const stream1 = await TileDocument.create<any>(ceramic, INITIAL_CONTENT, { deterministic: true }, { syncTimeoutSeconds: 0 });
    await anchorUpdate(ceramic, stream1);
    await stream1.update({ abc: 321, def: 456, gh: 987 });
    await anchorUpdate(ceramic, stream1);

    const ceramic2 = await createCeramic(ipfs, { anchorOnRequest: false });
    const stream2 = await TileDocument.create(ceramic, INITIAL_CONTENT, { deterministic: true }, { syncTimeoutSeconds: 0 });
    const streamState2 = await ceramic2.repository.load(stream2.id, { syncTimeoutSeconds: 0 });
    const snapshot = await ceramic2.repository.stateManager.rewind(streamState2, stream1.commitId);

    expect(StreamUtils.statesEqual(snapshot.state, stream1.state));
    const snapshotStream = streamFromState<TileDocument>(ceramic2.context, ceramic2._streamHandlers, snapshot.value);
    await expect(
      snapshotStream.update({ abc: 1010 }),
    ).rejects.toThrow(
      'Historical stream commits cannot be modified. Load the stream without specifying a commit to make updates.',
    );

    await ceramic2.close();
  });
});

test('handles basic conflict', async () => {
  const stream1 = await TileDocument.create(ceramic, INITIAL_CONTENT);
  stream1.subscribe();
  const streamState1 = await ceramic.repository.load(stream1.id, {});
  const streamId = stream1.id;
  await anchorUpdate(ceramic, stream1);
  const tipPreUpdate = stream1.tip;

  const newContent = { abc: 321, def: 456, gh: 987 };
  let updateRec = await stream1.makeCommit(ceramic, newContent)
  await ceramic.repository.stateManager.applyCommit(streamState1.id, updateRec, { anchor: true, publish: false });

  await anchorUpdate(ceramic, stream1);
  expect(stream1.content).toEqual(newContent);
  const tipValidUpdate = stream1.tip;
  // create invalid change that happened after main change

  const initialState = await ceramic.repository.stateManager
    .rewind(streamState1, streamId.atCommit(streamId.cid))
    .then((stream) => stream.state);
  const state$ = new RunningState(initialState);
  ceramic.repository.add(state$);
  await (ceramic.repository.stateManager as any)._handleTip(state$, tipPreUpdate);
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const conflictingNewContent = { asdf: 2342 };
  const stream2 = streamFromState<TileDocument>(ceramic.context, ceramic._streamHandlers, state$.value, ceramic.repository.updates$);
  stream2.subscribe();
  updateRec = await stream2.makeCommit(ceramic, conflictingNewContent)
  await ceramic.repository.stateManager.applyCommit(state$.id, updateRec, { anchor: true, publish: false });

  await anchorUpdate(ceramic, stream2);
  const tipInvalidUpdate = state$.tip;
  expect(stream2.content).toEqual(conflictingNewContent);
  // loading tip from valid log to stream with invalid
  // log results in valid state
  await (ceramic.repository.stateManager as any)._handleTip(state$, tipValidUpdate);
  expect(stream2.content).toEqual(newContent);

  // loading tip from invalid log to stream with valid
  // log results in valid state
  await (ceramic.repository.stateManager as any)._handleTip(streamState1, tipInvalidUpdate);
  expect(stream1.content).toEqual(newContent);

  // Loading valid commit works
  const streamAtValidCommit = await ceramic.repository.stateManager.rewind(streamState1, streamId.atCommit(tipValidUpdate));
  expect(streamAtValidCommit.value.content).toEqual(newContent);

  // Loading invalid commit fails
  await expect(ceramic.repository.stateManager.rewind(streamState1, streamId.atCommit(tipInvalidUpdate))).rejects.toThrow(
    `Requested commit CID ${tipInvalidUpdate.toString()} not found in the log for stream ${streamId.toString()}`,
  );
}, 10000);

test('enforces schema in update that assigns schema', async () => {
  const schemaDoc = await TileDocument.create(ceramic, STRING_MAP_SCHEMA);
  await anchorUpdate(ceramic, schemaDoc);

  const stream = await TileDocument.create(ceramic, { stuff: 1 });
  const streamState = await ceramic.repository.load(stream.id, {});
  await anchorUpdate(ceramic, stream);
  const updateRec = await stream.makeCommit(ceramic, null, { schema: schemaDoc.commitId });
  await expect(ceramic.repository.stateManager.applyCommit(streamState.id, updateRec)).rejects.toThrow(
    "Validation Error: data/stuff must be string",
  );
});

test('enforce previously assigned schema during future update', async () => {
  const schemaDoc = await TileDocument.create(ceramic, STRING_MAP_SCHEMA);
  await anchorUpdate(ceramic, schemaDoc);

  const conformingContent = { stuff: 'foo' };
  const nonConformingContent = { stuff: 1 };
  const stream = await TileDocument.create<any>(ceramic, conformingContent, { schema: schemaDoc.commitId });
  const streamState = await ceramic.repository.load(stream.id, {});
  await anchorUpdate(ceramic, stream);

  const updateRec = await stream.makeCommit(ceramic, nonConformingContent);
  await expect(ceramic.repository.stateManager.applyCommit(streamState.id, updateRec, { anchor: false, publish: false })).rejects.toThrow(
    "Validation Error: data/stuff must be string",
  );
});

test('should announce change to network', async () => {
  const publishTip = jest.spyOn(ceramic.dispatcher, 'publishTip');
  const stream1 = await TileDocument.create<any>(ceramic, INITIAL_CONTENT);
  stream1.subscribe();
  const streamState1 = await ceramic.repository.load(stream1.id, {});
  expect(publishTip).toHaveBeenCalledTimes(1);
  expect(publishTip).toHaveBeenCalledWith(stream1.id, stream1.tip);
  await publishTip.mockClear();

  const updateRec = await stream1.makeCommit(ceramic, { foo: 34 });
  await ceramic.repository.stateManager.applyCommit(streamState1.id, updateRec, { anchor: false, publish: true });
  expect(publishTip).toHaveBeenCalledWith(stream1.id, stream1.tip);
});
