import { DataStream, StreamMetadata, Modality } from "../data-stream.interface";
import { BehaviorSubject, Subject, Observable, forkJoin } from "rxjs";

type ModalityConfig = {
    [key in Modality]?: {
        samplingRate: number,
        channelNames: string[],
        [additionalProp: string]: any,
    };
}

export interface EventCallbacks {
    onSuccess?: () => void,
    onError?: (error: Error) => void
}

export abstract class BaseReceiver {

    protected modalityData$: Map<Modality, Subject<DataStream>> = new Map();
    protected isConnected$: BehaviorSubject<boolean> = new BehaviorSubject(false);

    abstract baseConfig: ModalityConfig;
    abstract deviceName: string;
    abstract modalities: Modality[];

    abstract connect(callbacks?: EventCallbacks): void;
    abstract disconnect(callbacks?: EventCallbacks): void;
    abstract startStream(callbacks?: EventCallbacks): void;
    abstract stopStream(callbacks?: EventCallbacks): void;

    protected onInit(): void { };
    protected onDestroy(): void { };

    public deviceID: string | number = 0;

    get data(): Observable<DataStream[]> {
        const observables = Array.from(this.modalityData$.values()).map(subject => subject.asObservable());
        return forkJoin(observables);
    }

    get isConnected(): boolean {
        return this.isConnected$.getValue()
    }

    set isConnected(newValue: boolean) {
        this.isConnected$.next(newValue);
    }

    constructor() {
        this.initializeDataSubjects();
    }

    private initializeDataSubjects(): void {
        for (const modality of this.modalities) {
            this.modalityData$.set(modality, new Subject<DataStream>());
        }
    }

    protected update(modality: Modality, data: any, additionalMetadata: Partial<StreamMetadata>): void {
        if (!this.isConnected) return;

        const subject = this.modalityData$.get(modality);
        if (!subject) {
            console.warn(`Data subject not initialized or properly set for ${modality}`)
        }

        const config = this.baseConfig[modality];
        if (!config) {
            console.warn(`Sampling rate and channel names not initialized or properly set for ${modality}`)
        }

        const currentData: DataStream = {
            modality,
            timestamp: Date.now(),
            data,
            metadata: {
                deviceID: this.deviceID!,
                device: this.deviceName,
                samplingRate: config!.samplingRate,
                channelNames: config!.channelNames,
                isConnected: this.isConnected,
                ...additionalMetadata
            }
        }
        subject?.next(currentData)
    }

    public getData(modality: Modality): Observable<DataStream> {
        const subject = this.modalityData$.get(modality);
        return subject!.asObservable();
    }

    public getSamplingRate(modality: Modality) {
        return this.baseConfig[modality]
    }

    public setSamplingRate(modality: Modality, newSamplingRate: number) {
        if (this.baseConfig?.[modality]) {
            this.baseConfig[modality].samplingRate = newSamplingRate
        }
    }

    public getChannelNames(modality: Modality) {
        return this.baseConfig[modality]
    }

    public setChannelNames(modality: Modality, newChannelNames: string[]) {
        if (this.baseConfig?.[modality]) {
            this.baseConfig[modality].channelNames = newChannelNames
        }
    }

    // I may comment out this getter favoring another one with the modality as an argument.
    /*
    get allSamplingRates(): { [key in Modality]?: number }[] {
        const samplingRates = []
        for (const [key, value] of Object.entries(this.baseConfig)) {
            samplingRates.push({ [key]: value.samplingRate })
        }
        return samplingRates
    }*/

}