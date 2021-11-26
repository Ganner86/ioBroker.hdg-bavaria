/*
 * Created with @iobroker/create-adapter v2.0.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
import * as utils from "@iobroker/adapter-core";
import * as schedule from "node-schedule";
import * as fs from "fs";
import * as path from "path";
import { HdgComm } from "./hdgcomm"
import { default as datapointCfg } from "../lib/datapoints.json";
import Component from "./lib/component";
import Datapoint from "./lib/datapoint";
import Boiler from "./lib/boiler";
import Tank from "./lib/tank";
import Supply from "./lib/supply";
import Circuit from "./lib/circuit";

class HdgBavaria extends utils.Adapter {
    numDatapoints = 0;
    nodes = "";
    hdgComm: HdgComm | null = null;
    job: schedule.Job | null = null;
    boiler: Boiler| null  = null;
    tank: Tank | null = null;
    supply: Supply | null = null;
    circuit: Circuit | null = null;
    components: Component[]

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: "hdg-bavaria",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    private async onReady(): Promise<void> {
        if(!this.sanityCheck()) {
            this.terminate("Aborting adapter");
        }

        if(!this.readConfiguration()) {
            this.terminate("Aborting adapter");
        }

        this.log.info("Creating device");

        // Create device
        this.setObject(this.config.name, {
            type: "device",
            common: {
                name: this.config.name
            },
            native: {},
        });

        this.createLogStates();
        this.createStatisticsStates();

        // Fix nodes string and do a first query
        this.nodes = this.nodes.substring(1);
        this.nodes = "nodes="+this.nodes;
        this.hdgComm = new HdgComm(this.config.ip, this.nodes)
        this.log.info(this.nodes);
        this.poll();

        // Schedule regular polling
        const rule = new schedule.RecurrenceRule();
        // @TODO This not clean, e.g. when using 18 minutes -> 0:00, 0:18, 0:36, 0:54, (!) 0:00, 0:18
        // BUT!! We rely on stats that the timer will fire at minute zero of every hour (xx:00)
        //rule.minute = new schedule.Range(0, 59, this.config.pollIntervalMins);
        this.job = schedule.scheduleJob("*/3 * * * *", () => {
            this.poll();
        })
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    private onUnload(callback: () => void): void {
        try {
            this.job?.cancel();
            callback();
        } catch (e) {
            callback();
        }
    }

    private readConfiguration(): boolean {
        try {
            for (let i = 0; i < datapointCfg.kessel.length; i++) {
                if (datapointCfg.kessel[i].typeName == this.config.kesselTyp) {
                    this.boiler = new Boiler(datapointCfg.kessel[i]);
                    break;
                }
            }
        } catch (e) {
            this.log.error("Kesselkonfiguration ungültig, konnte nicht eingelesen werden");
            this.log.error((<Error>e).message)
            return false;
        }
        if(this.boiler == null) {
            this.log.error("Kesseltyp wurde nicht gefunden");
            return false;
        }
        try {
            for (let i = 0; i < datapointCfg.puffer.length; i++) {
                if (datapointCfg.puffer[i].typeName == this.config.pufferTyp) {
                    this.tank = new Tank(datapointCfg.puffer[i]);
                    break;
                }
            }
        } catch (e) {
            this.log.error("Pufferkonfiguration ungültig, konnte nicht eingelesen werden");
            this.log.error((<Error>e).message)
            return false;
        }
        if(this.tank == null) {
            this.log.error("Puffertype wurde nicht gefunden");
            return false;
        }
        try {
            for (let i = 0; i < datapointCfg.zufuehrung.length; i++) {
                if (datapointCfg.zufuehrung[i].typeName == "Standard") { // @TODO: Nothing else supported
                    this.supply = new Supply(datapointCfg.zufuehrung[i]);
                    break;
                }
            }
        } catch (e) {
            this.log.error("Zuführungskonfiguration ungültig, konnte nicht eingelesen werden")
            this.log.error((<Error>e).message)
            return false;
        }
        if(this.supply == null) {
            this.log.error("Zuführungstyp wurde nicht gefunden");
            return false;
        }
        try {
            for (let i = 0; i < datapointCfg.heizkreis.length; i++) {
                if (datapointCfg.heizkreis[i].typeName == "Standard") { // @TODO: Nothing else supported
                    this.circuit= new Circuit(datapointCfg.heizkreis[i]);
                    break;
                }
            }
        } catch (e) {
            this.log.error("Heizkreiskonfiguration ungültig, konnte nicht eingelesen werden")
            this.log.error((<Error>e).message)
            return false;
        }
        if(this.circuit == null) {
            this.log.error("Heizkreistyp wurde nicht gefunden");
            return false;
        }

        this.components = [this.boiler, this.tank, this.supply, this.circuit];

        return true;
    }
    private sanityCheck(): boolean {
        this.log.info("sanity check");
        if(this.validateIPaddress(this.config.ip) == false) {
            this.log.error("Illegal IP Address: "+this.config.ip);
            return false;
        }
        if(this.config.name == "") {
            this.log.error("Kein Name gesetzt");
            return false;
        }
        if(this.config.pollIntervalMins < 1) {
            this.log.warn("Interval zu klein, setze auf 1 Minute");
            this.config.pollIntervalMins = 1;
        } else if(this.config.pollIntervalMins > 20) {
            this.log.warn("Interval zu groß, setze auf 20 Minuten");
            this.config.pollIntervalMins = 20;
        }
        this.log.info("IP address: " + this.config.ip);
        this.log.info("Name der Heizungsanlage: " + this.config.name);
        this.log.info("Kesseltyp: " + this.config.kesselTyp);
        this.log.info("Puffertyp: " + this.config.pufferTyp);
        this.log.info("Anzahl Puffer: " + this.config.anzahlPuffer);
        this.log.info("Anzahl Heizkreise: " + this.config.anzahlHeizkreise);
        this.log.info("Polling interval: " + this.config.pollIntervalMins.toString());
        return true;
    }

    private validateIPaddress(ipaddress: string): boolean {
        if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress)) {
            return (true);
        }
        return (false);
    }

    private createLogStates(): void {
        for (let i = 0; i < this.components.length; i++) {
            const c = this.components[i];
            const channel = c!.channel;
            this.log.info("Create channel " + this.config.name + "." + c!.channel);
            this.setObject(this.config.name + "." + c!.channel, {
                type: "channel",
                common: {
                    name: c!.name,
                },
                native: {},
            });

            const len = c!.states.length;
            this.numDatapoints += len;
            for (let j = 0; j < len; j++) {
                const state = c!.states[j];
                this.log.info("Create state " + this.config.name + "." + channel + "." + state.id);
                const stateCommon: ioBroker.StateCommon = {
                    unit: state.unit,
                    name: state.name,
                    type: state.iobType as ioBroker.CommonType,
                    role: state.iobRole,
                    read: true,
                    write: true,
                }
                this.createState(this.config.name, c!.channel, state.id, stateCommon);
                this.nodes += "-" + state.dataid + "T";
            }
        }
    }

    private createStatisticsStates(): void {
        // Create statistics channel
        this.setObject(this.config.name + ".statistics", {
            type: "channel",
            common: {
                name: "statistics",
            },
            native: {},
        });
        this.createBufferEnergyStates();
    }

    private createBufferEnergyStates(): void {
        //if(this.bufferEnergy.datapoints.length == 0) return;
        //this.createState(this.config.name, "statistics", "PufferEnergieabgabeHeute", {
        //    name: "Puffer Energieabgabe heute",
        //    type: "number",
        //    role: "value",
        //    unit: "Wh",
        //    read: true,
        //    write: false,
        //});
        this.createState(this.config.name, "statistics", "ThermischeKapazitaet", {
            name: "Aktuelle thermische Kapazität des Puffers",
            type: "number",
            role: "level",
            unit: "Wh",
            read: true,
            write: false,
        });
    }

    private poll(): void {
        this.log.info("Query " + this.numDatapoints.toString() + " datapoints from " + this.config.ip);
        this.hdgComm?.dataRefresh( (data: any, error: string): void => {
            if (data.length != this.numDatapoints) {
                this.log.warn("Error when reading data: "+error);
                this.log.warn("Unexpected length "+data.length+" of response from " + this.config.ip);
                return;
            }
            let dpCnt = 0;
            for(let i=0; i < this.components!.length; i++) {
                for(let j=0; j < this.components[i].states.length; j++) {
                    const c = this.components[i]
                    const state = this.components[i].states[j];
                    try {
                        var value = this.parseDatapoint(state, data[dpCnt].text);
                        if (value != undefined) {
                            this.setState(this.config.name + "." + c.channel + "." + state.id, { val: value, ack: true });
                            state.value = value;
                        }
                    } catch (e) {
                        this.log.warn("Exception while reading response of element " + i.toString());
                        return;
                    }
                    dpCnt++;
                }
            }
            this.log.debug("Updating tank energy")
            if(this.tank !== null)
                this.setState(this.config.name + ".statistics.ThermischeKapazitaet", this.tank.calcEnergy());
        })
    }

    private parseDatapoint(state: Datapoint, text: string) {
        if (state.hdgType == "int") {
            return parseInt(text);
        } else if (state.hdgType == "float") {
            return parseFloat(text);
        } else if (state.hdgType == "string") {
            return text;
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new HdgBavaria(options);
} else {
    // otherwise start the instance directly
    (() => new HdgBavaria())();
}