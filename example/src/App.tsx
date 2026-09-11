import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState, Linking, Platform, Pressable, ScrollView, StatusBar,
  StyleSheet, Text, View,
} from 'react-native';
import { NitroModules } from 'react-native-nitro-modules';
import { PUSHUP_CONFIG, type NitroPoseExercises } from '@enfp-dev-studio/react-native-nitro-pose-exercises';
import {
  createReferencePushupState, type ReferencePushupMode,
} from '@enfp-dev-studio/react-native-nitro-pose-exercises/counter';
import { useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { createSynchronizable, type Synchronizable } from 'react-native-worklets';

import { EMPTY_COUNTER_STATUS, PoseCamera, type CounterStatus } from './PoseCamera';

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForFrames(frameBusy: Synchronizable<boolean>) {
  while (frameBusy.getBlocking()) {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

const phaseLabels: Record<CounterStatus['phase'], string> = {
  waitingForUp: 'Straighten your arms to get ready',
  up: 'Ready', descent: 'Lowering', down: 'Bottom confirmed', ascent: 'Rising',
};

export default function App() {
  const [generation, setGeneration] = useState(0);
  const [appState, setAppState] = useState(AppState.currentState);
  useEffect(() => {
    const listener = AppState.addEventListener('change', setAppState);
    return () => listener.remove();
  }, []);

  return (
    <View style={styles.app}>
      <StatusBar barStyle="light-content" backgroundColor="#111A20" />
      <SessionScreen key={generation} active={appState === 'active'}
        onNewSession={() => setGeneration((previous) => previous + 1)} />
    </View>
  );
}

function SessionScreen({ active, onNewSession }: {
  active: boolean; onNewSession: () => void;
}) {
  const device = useCameraDevice('front');
  const { hasPermission, canRequestPermission, requestPermission } = useCameraPermission();
  const [mode, setMode] = useState<ReferencePushupMode>('full');
  const [engine, setEngine] = useState<NitroPoseExercises | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [finished, setFinished] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reps, setReps] = useState(0);
  const [error, setError] = useState('');
  const [trackingMessage, setTrackingMessage] = useState('Camera is ready when you are.');
  const [status, setStatus] = useState<CounterStatus>(EMPTY_COUNTER_STATUS);
  const [inferenceMs, setInferenceMs] = useState(0);
  const [processedFrames, setProcessedFrames] = useState(0);
  const mounted = useRef(true);
  const lifecycleRevision = useRef(0);
  const ending = useRef(false);
  const didStart = useRef(false);
  const total = useRef(0);
  const currentEngine = useRef<NitroPoseExercises | null>(null);
  const stoppedEngines = useRef(new WeakSet<NitroPoseExercises>());
  const finishOperation = useRef<Promise<number> | null>(null);
  const frameBusy = useMemo(() => createSynchronizable(false), []);
  const enabled = useMemo(() => createSynchronizable(false), []);
  const counter = useMemo(() => createSynchronizable(createReferencePushupState()), []);
  const counterStatus = useMemo(() => createSynchronizable(EMPTY_COUNTER_STATUS), []);

  const recordCount = useCallback((confirmedReps: number) => {
    if (Number.isSafeInteger(confirmedReps) && confirmedReps >= 0) {
      total.current = Math.max(total.current, confirmedReps);
      if (mounted.current) setReps(total.current);
    }
    return total.current;
  }, []);

  const finish = useCallback((): Promise<number> => {
    if (finishOperation.current) return finishOperation.current;
    ending.current = true;
    enabled.setBlocking(false);
    if (mounted.current) {
      setBusy(true);
      setRunning(false);
    }
    const revision = lifecycleRevision.current;
    const instance = currentEngine.current;
    const sessionHadStarted = didStart.current;
    const operation = (async () => {
      // An accepted in-flight result must reach the final total before shutdown.
      await waitForFrames(frameBusy);
      const finalCount = counter.getBlocking().reps;
      if (lifecycleRevision.current === revision) recordCount(finalCount);
      if (instance) {
        instance.stopReferenceMotion();
        if (sessionHadStarted && !stoppedEngines.current.has(instance)) {
          instance.stopSession();
          stoppedEngines.current.add(instance);
        }
      }
      return finalCount;
    })();
    finishOperation.current = operation;
    void operation.catch((cause: unknown) => {
      if (mounted.current && lifecycleRevision.current === revision) setError(`Session stop: ${messageOf(cause)}`);
    }).finally(() => {
      if (mounted.current && lifecycleRevision.current === revision) {
        setFinished(true);
        setBusy(false);
      }
    });
    return operation;
  }, [counter, enabled, frameBusy, recordCount]);

  const onCount = useCallback((confirmedReps: number) => {
    // A callback queued by an old detector must not change a refreshed session.
    if (engine && currentEngine.current === engine) recordCount(confirmedReps);
  }, [engine, recordCount]);

  const fail = useCallback((message: string) => {
    enabled.setBlocking(false);
    if (mounted.current) setError(message);
    // Keep the final total and drain any admitted frame before allowing restart.
    void finish().catch(() => {});
  }, [enabled, finish]);

  const onCameraFailure = useCallback((message: string) => {
    if (engine && currentEngine.current === engine) fail(message);
  }, [engine, fail]);

  useEffect(() => {
    let disposed = false;
    let instance: NitroPoseExercises | undefined;
    lifecycleRevision.current += 1;
    mounted.current = true;
    ending.current = true;
    enabled.setBlocking(false);
    currentEngine.current = null;
    finishOperation.current = null;
    didStart.current = false;
    setEngine(null);
    setInitializing(true);
    setRunning(false);
    setStarted(false);
    setFinished(false);
    setBusy(false);
    setError('');
    setStatus(EMPTY_COUNTER_STATUS);
    setInferenceMs(0);
    setProcessedFrames(0);
    setTrackingMessage('Camera is ready when you are.');
    const initialization = (async () => {
      // Effect replay/Fast Refresh starts a fresh validation session. Drain the
      // old worker before resetting shared counts or replacing its detector.
      await waitForFrames(frameBusy);
      if (disposed) return;
      total.current = 0;
      setReps(0);
      counter.setBlocking(createReferencePushupState());
      counterStatus.setBlocking(EMPTY_COUNTER_STATUS);
      instance = NitroModules.createHybridObject<NitroPoseExercises>('NitroPoseExercises');
      await instance.initialize('');
      if (disposed) return;
      // The current iOS frame path requires an active native exercise session.
      // The maintained TypeScript counter remains the only displayed rep source.
      if (Platform.OS === 'ios') instance.loadExercise(PUSHUP_CONFIG);
      currentEngine.current = instance;
      ending.current = false;
      setEngine(instance);
    })().catch((cause: unknown) => {
      if (!disposed) setError(`Initialization: ${messageOf(cause)}`);
    }).finally(() => {
      if (!disposed) setInitializing(false);
    });

    return () => {
      disposed = true;
      mounted.current = false;
      enabled.setBlocking(false);
      const sessionHadStarted = didStart.current;
      const pendingFinish = finishOperation.current;
      // Teardown is scoped to this effect's detector. It must not call finish(),
      // whose terminal UI/ref updates would leak into an effect replay.
      void initialization
        .then(() => pendingFinish?.catch(() => {}))
        .then(async () => {
          await waitForFrames(frameBusy);
          try {
            instance?.stopReferenceMotion();
            if (instance && sessionHadStarted && !stoppedEngines.current.has(instance)) {
              instance.stopSession();
              stoppedEngines.current.add(instance);
            }
          } finally {
            instance?.release();
          }
        }).catch((cause: unknown) => console.warn('Pose cleanup:', messageOf(cause)))
        .finally(() => {
          if (currentEngine.current === instance) currentEngine.current = null;
        });
    };
  }, [counter, counterStatus, enabled, frameBusy]);

  useEffect(() => {
    const revision = lifecycleRevision.current;
    enabled.setBlocking(active && running && !ending.current);
    if (!active && didStart.current) {
      void waitForFrames(frameBusy)
        .then(() => {
          if (lifecycleRevision.current === revision) recordCount(counter.getBlocking().reps);
        })
        .catch((cause: unknown) => {
          if (lifecycleRevision.current === revision) fail(messageOf(cause));
        });
    }
    return () => enabled.setBlocking(false);
  }, [active, counter, enabled, fail, frameBusy, recordCount, running]);

  useEffect(() => {
    if (!running || !engine) return;
    const timer = setInterval(() => {
      if (currentEngine.current !== engine) return;
      try {
        recordCount(counter.getBlocking().reps);
        setStatus(counterStatus.getBlocking());
        setInferenceMs(engine.lastProcessingMs);
        setProcessedFrames(engine.resultVersion);
      } catch (cause) {
        fail(messageOf(cause));
      }
    }, 250);
    return () => clearInterval(timer);
  }, [counter, counterStatus, engine, fail, recordCount, running]);

  async function start() {
    if (!engine || !device || busy || didStart.current || ending.current) return;
    const instance = engine;
    const revision = lifecycleRevision.current;
    setBusy(true);
    setError('');
    try {
      if (!hasPermission && !(canRequestPermission && await requestPermission())) {
        if (mounted.current && lifecycleRevision.current === revision) setError('Camera access is required. Enable it in Settings.');
        return;
      }
      if (!mounted.current || currentEngine.current !== instance || ending.current) return;
      await waitForFrames(frameBusy);
      if (!mounted.current || currentEngine.current !== instance || ending.current) return;
      counter.setBlocking(createReferencePushupState(mode));
      counterStatus.setBlocking(EMPTY_COUNTER_STATUS);
      if (Platform.OS === 'ios') instance.startSession(0, 0);
      didStart.current = true;
      setStarted(true);
      setRunning(true);
    } catch (cause) {
      if (lifecycleRevision.current === revision) fail(messageOf(cause));
    } finally {
      if (mounted.current && lifecycleRevision.current === revision && !ending.current) setBusy(false);
    }
  }

  const modeLocked = started || busy || finished;
  const canStart = !!engine && !!device && !busy && !finished && active;
  const primaryLabel = busy ? started ? 'Finishing current frame…' : 'Preparing session…'
    : running ? 'Finish session' : initializing ? 'Preparing engine…' : 'Start camera counter';

  return (
    <>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>MAINTAINED NITRO POSE · VALIDATION</Text>
        <Text style={styles.title}>Push-up counter</Text>
        <Text style={styles.subtitle}>Camera inference → tracking → exercise validation</Text>
      </View>
      <View style={styles.preview}>
        {device && engine && hasPermission && (
          <PoseCamera key={lifecycleRevision.current} device={device} engine={engine} frameBusy={frameBusy}
            enabled={enabled} counter={counter} counterStatus={counterStatus}
            onCount={onCount} active={running && active}
            onError={onCameraFailure} onStatus={setTrackingMessage} />
        )}
        {(!running || !active) && (
          <View pointerEvents="none" style={styles.placeholder}>
            <Text style={styles.placeholderTitle}>{finished ? 'Session complete'
              : !active ? 'Paused while app is inactive'
                : initializing ? 'Loading native pose engine…'
                  : !device ? 'No front camera available' : 'Place the phone securely'}</Text>
            <Text style={styles.placeholderBody}>{finished
              ? 'The confirmed count includes the final in-flight frame.'
              : 'Keep your shoulders, wrists, hips, and legs in view.'}</Text>
          </View>
        )}
        <View pointerEvents="none" style={styles.counterBadge}>
          <Text style={styles.counterLabel}>CONFIRMED REPS</Text>
          <Text style={styles.count}>{reps}</Text>
          <Text style={styles.counterMode}>{mode === 'full' ? 'Full push-up' : 'Knee push-up'}</Text>
        </View>
      </View>
      <ScrollView style={styles.controls} contentContainerStyle={styles.controlsContent}>
        <View style={styles.modeRow} accessibilityRole="radiogroup">
          {(['full', 'knee'] as const).map((value) => (
            <Pressable key={value} accessibilityRole="radio"
              accessibilityState={{ checked: mode === value, disabled: modeLocked }}
              disabled={modeLocked} onPress={() => setMode(value)}
              style={[styles.mode, mode === value && styles.selectedMode]}>
              <Text style={styles.modeText}>{value === 'full' ? 'Full push-up' : 'Knee push-up'}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={styles.tracking}>{running && active ? trackingMessage
          : finished ? 'Counts are kept for this validation session only.'
            : started ? 'Paused; return to resume the same count.' : 'Choose a mode, then start.'}</Text>
        {running && active && (
          <View style={styles.diagnostics}>
            <Text style={styles.diagnosticText}>{status.armsVisible
              ? `${phaseLabels[status.phase]} · ${Math.round(status.angle)}°`
              : 'Waiting for shoulder, elbow, and wrist landmarks'}</Text>
            <Text style={styles.diagnosticText}>Last inference: {Math.max(0, inferenceMs).toFixed(1)} ms · Frames: {processedFrames}</Text>
            {status.reasons.length > 0 && <Text selectable style={styles.reason}>Rejected: {status.reasons.join(', ')}</Text>}
          </View>
        )}
        {!!error && <Text selectable accessibilityRole="alert" style={styles.error}>{error}</Text>}
        {finished ? (
          <Pressable accessibilityRole="button" style={styles.primary} onPress={onNewSession}>
            <Text style={styles.primaryText}>New session</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" disabled={running ? busy : !canStart}
            style={[styles.primary, (running ? busy : !canStart) && styles.disabled]}
            onPress={() => void (running ? finish().catch(() => {}) : start())}>
            <Text style={styles.primaryText}>{primaryLabel}</Text>
          </Pressable>
        )}
        {!hasPermission && !canRequestPermission && (
          <Pressable accessibilityRole="button" style={styles.secondary}
            onPress={() => void Linking.openSettings().catch((cause: unknown) => setError(messageOf(cause)))}>
            <Text style={styles.secondaryText}>Open camera permission settings</Text>
          </Pressable>
        )}
        {!!error && !started && !busy && (
          <Pressable accessibilityRole="button" style={styles.secondary} onPress={onNewSession}>
            <Text style={styles.secondaryText}>Reinitialize engine</Text>
          </Pressable>
        )}
        <Text style={styles.footnote}>This screen uses the installed package artifact. It adds no simulated repetitions.</Text>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: '#111A20', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight ?? 24 : 54 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 18, gap: 6 },
  eyebrow: { color: '#66E3E7', fontSize: 10, fontWeight: '700', letterSpacing: 1.4 },
  title: { color: '#FFFFFF', fontSize: 28, fontWeight: '700' },
  subtitle: { color: '#AEC3CE', fontSize: 12 },
  preview: { flex: 1, minHeight: 210, overflow: 'hidden', backgroundColor: '#091116', marginHorizontal: 16, borderRadius: 18, borderWidth: 1, borderColor: '#29444F' },
  placeholder: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', padding: 28, paddingTop: 120, gap: 10 },
  placeholderTitle: { color: '#FFFFFF', textAlign: 'center', fontSize: 18, fontWeight: '600' },
  placeholderBody: { color: '#AEC3CE', textAlign: 'center', fontSize: 13, lineHeight: 20 },
  counterBadge: { position: 'absolute', top: 16, left: 16, backgroundColor: '#111A20CC', borderRadius: 14, paddingHorizontal: 16, paddingVertical: 12 },
  counterLabel: { color: '#AEC3CE', fontSize: 9, fontWeight: '700', letterSpacing: 1 },
  count: { color: '#FFFFFF', fontSize: 58, lineHeight: 66, fontWeight: '700', fontVariant: ['tabular-nums'] },
  counterMode: { color: '#66E3E7', fontSize: 11 },
  controls: { flexGrow: 0, maxHeight: '48%' },
  controlsContent: { padding: 18, paddingBottom: 32, gap: 12 },
  modeRow: { flexDirection: 'row', gap: 10 },
  mode: { flex: 1, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#29444F', alignItems: 'center' },
  selectedMode: { borderColor: '#66E3E7', backgroundColor: '#183A43' },
  modeText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  tracking: { color: '#DDE9EF', fontSize: 13, lineHeight: 18 },
  diagnostics: { padding: 12, backgroundColor: '#192A33', borderRadius: 12, gap: 5 },
  diagnosticText: { color: '#AEC3CE', fontSize: 12 },
  reason: { color: '#FFFFFF', fontSize: 12, lineHeight: 18 },
  error: { color: '#FFFFFF', padding: 12, borderColor: '#66E3E7', borderWidth: 1, borderRadius: 12, fontSize: 12, lineHeight: 18 },
  primary: { backgroundColor: '#66E3E7', borderRadius: 14, minHeight: 52, alignItems: 'center', justifyContent: 'center', padding: 12 },
  primaryText: { color: '#091116', fontWeight: '700', fontSize: 15 },
  disabled: { opacity: 0.4 },
  secondary: { minHeight: 42, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: '#66E3E7', fontSize: 13 },
  footnote: { color: '#7E9BAA', fontSize: 10, lineHeight: 15 },
});
