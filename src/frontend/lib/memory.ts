import * as Bowser from 'bowser'
import { v4 as uuidv4 } from 'uuid'

export const INITIAL_CONFIG = {
  duration: 10 * 1000,
  waitingDuration: 0,
  cuttedDuration: 0,
  maxLoop: 0,
  infiniteLoop: false,
  invalid: false,
  soundDuration: 10 * 1000,
  sound: false,
}

export const INTIAL_STATE = {
  duration: 0,
  coutingTimerId: 1,
  counting: false,
  loop: 0,
}

export const INITIAL_COUNT = INTIAL_STATE.duration

type DeepPartial < T > = {
  [P in keyof T]?: DeepPartial<T[P]>;
}

type EeportEntry = {
  // git の commit hash
  revisionId: string,
  // process.env.NODE_ENV
  env: string,
  // location.origin
  origin: string,
  // location.pathname
  pathname: string,
  // context ごとにユニークな id。
  // ここでの context とは、ページにアクセスしてから unload イベントが発行されドキュメントのインスタンスが破棄されるまでの期間を指している。
  // この id が無いと entry を紐付けて測定結果を分析することが困難なため、entry に含めている。
  contextId: string,
  // entry が生成された時刻
  timestamp: string,
  // context が生まれてからの経過時間
  elapsedTimeSinceContextCreated: number,
  // メモリ使用量
  memoryMeasurement: MemoryMeasurement,
  // ブラウザやOSに関する情報
  bowser: Bowser.Parser.ParsedResult,
} & AppState // アプリケーションの状態

function measurementInterval () {
  const MEAN_INTERVAL_IN_MS = 5 * 60 * 1000 // 5 分
  return -Math.log(Math.random()) * MEAN_INTERVAL_IN_MS
}

type AppState = {
  configInUse: typeof INITIAL_CONFIG,
  state: typeof INTIAL_STATE;
  // カウントダウンタイマーの残り時間
  count: typeof INITIAL_COUNT;
  // カウントダウン開始時に毎回生成される uuid
  // 1回目のカウントダウンと2回目のカウントダウンの entry を区別するために用いられる。
  countdownId: string;
}

// メモリの測定結果と合わせて送信したいアプリケーションの状態を管理するクラス
class AppStateManager {
  private currentState: AppState;
  constructor () {
    this.currentState = {
      configInUse: { ...INITIAL_CONFIG },
      state: { ...INTIAL_STATE },
      count: INITIAL_COUNT,
      countdownId: uuidv4(),
    }
  }

  updateState (newState: DeepPartial<AppState>) {
    // NOTE: Vue の data は getter を使って構成されているので、プロパティにアクセスするタイミングによって値が変わってしまう。
    // これでは集計上不都合なので、ここで一度 pure なオブジェクトに変換している。
    this.currentState = JSON.parse(JSON.stringify({
      configInUse: {
        ...this.currentState.configInUse,
        ...newState.configInUse,
        // Infinity は JSON に変換できないので -1 として扱う
        maxLoop: newState.configInUse?.maxLoop === Infinity ? -1 : (newState.configInUse?.maxLoop ?? this.currentState.configInUse.maxLoop),
      },
      state: {
        ...this.currentState.state,
        ...newState.state,
      },
      countdownId: newState.countdownId ?? this.currentState.countdownId,
      count: newState.count ?? this.currentState.count,
    }))
  }

  getCurrentState (): AppState {
    return this.currentState
  }
}

export const appStateManager = new AppStateManager()
const CONTEXT_ID = uuidv4()

class MemoryMeasurementScheduler {
  appStateManager: AppStateManager;
  bower: Bowser.Parser.ParsedResult;
  timeOfContextCreated: number;

  constructor (appStateManager: AppStateManager) {
    this.appStateManager = appStateManager
    this.bower = Bowser.parse(window.navigator.userAgent)
    this.timeOfContextCreated = Date.now()
  }

  private async measureAndReportMemory () {
    if (!performance.measureMemory) return
    try {
      // NOTE: 仕様では measureMemory を呼び出してからGCが発生するまでの時間に関する規定は一切無く、
      // ブラウザごとにタイミングも異なる。つまり、GCの呼び出しがいつ行われても問題ないよう
      // measureMemory の呼び出し側の実装には注意する必要がある。ちなみに Chrome 84 は measureMemory を
      // 呼び出した 10 秒後にGCを実行し、Promise が resolve される実装になっている。
      const memoryMeasurement = await performance.measureMemory()
      const appState = appStateManager.getCurrentState()
      const timestamp = new Date()
      const reportEntry: EeportEntry = {
        revisionId: __REVISION_ID__,
        env: process.env.NODE_ENV || 'development',
        origin: location.origin,
        pathname: location.pathname,
        contextId: CONTEXT_ID,
        timestamp: timestamp.toISOString(),
        elapsedTimeSinceContextCreated: timestamp.getTime() - this.timeOfContextCreated,
        memoryMeasurement,
        bowser: this.bower,
        ...appState,
      }
      console.log('memory-measurement', reportEntry)
      await fetch('/.netlify/functions/aggregate-memory-measurement', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reportEntry),
      })
    } catch (error) {
      if (error instanceof DOMException &&
          error.name === 'SecurityError') {
        console.log('The context is not secure.')
      } else {
        throw error
      }
    }
  }

  // 定期的にメモリ使用量の測定を行うようスケジューラーをセットする。
  // 測定はおおよそ 5 分間隔で行われる。
  // ただし素朴に 5 分おきに測定するとページにアクセスしてから 0 〜 5分経過した際のデータが集計されず、
  // データに偏りが発生してしまう。そこで、ここではポアソン分布を利用して測定のタイミングを分散させ、
  // どの経過時間においても同じ確率でメモリ使用量の測定が実行されるようにしている。
  start () {
    if (!performance.measureMemory) return

    console.log('start measurement scheduler')

    const scheduleMeasurement = () => {
      const interval = measurementInterval()
      console.log(`Scheduling memory measurement in ${Math.round(interval / 1000)} seconds (${new Date(Date.now() + interval).toLocaleString()}).`)
      window.setTimeout(() => {
        this.measureAndReportMemory()
        scheduleMeasurement()
      }, interval)
    }
    scheduleMeasurement()
  }
}

export const memoryMeasurementScheduler = new MemoryMeasurementScheduler(appStateManager)
