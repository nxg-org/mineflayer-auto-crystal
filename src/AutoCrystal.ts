import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { promisify } from "util";
import { Block } from "prismarine-block";
import { genericPlaceOptions } from "./types";
import { testFindPosition, oldFindPosition } from "./testPlacement";

const sleep = promisify(setTimeout);

interface DebugOptions {
    useTime?: boolean;
    useTimeEnd?: boolean;
}

export interface Options {
    /**
     * Use backup/secondary algorithm for detecting good crystal placements. default is `false`.
     */
    useBackupPosAlgorithm?: boolean;
    /**
     * See https://github.com/PrismarineJS/mineflayer/issues/2030.
     */
    ignoreInventoryCheck?: boolean;
    /**
     * If set to true it will automatically equip an end crystal. default is `true`
     */
    autoEquip?: boolean;
    /**
     * Should the bot load positions asynchronously or synchronously. Default is `sync`.
     */
    asyncLoadPositions?: boolean;
    /**
     * Care about other end crystal placements. Default is `false`.
     */
    careAboutOtherCrystals?: boolean;
    /**
     * Emits the `error` event when an error occurs internally. default is `false`
     */
    logErrors?: boolean;
    /**
     * Logs information about what AutoCrystal is up to. default is `false`
     */
    logDebug?: boolean;
    /**
     * If the damage exceeds the threshold, it will not place / break the crystal. default is `5`
     */
    damageThreshold?: number;
    /**
     * If the damage is under the threshold, it will not place / break the crystal. default is `2`
     */
    targetDamageThreshold?: number;
    /**
     *  The distance the bot will detect the player from. Default is `6`.
     */
    playerDistance?: number;
    /**
     * The delay in ticks between each crystal placement. default is `1`
     */
    placeDelay?: number;
    /**
     *  The number of crystals placed per tick. Default is `1`.
     */
    crystalsPerTick?: number;
    /**
     *  The delay in ticks before attacking a crystal. Default is `1`.
     */
    breakDelay?: number;
    /**
     *  The distance that the bot can hit crystals. Default is `4`.
     */
    breakDistance?: number;
    /**
     *  The distance that the bot can place crystals. Default is `4`.
     */
    placeDistance?: number;
    /**
     * What the bot should prefer when choosing where to place a crystal. default is `none`
     */
    priority?: "none" | "damage" | "distance";
    /**
     * The mode to use for placing the crystal. can be `suicide` or `safe`
     */
    placeMode: "suicide" | "safe";
    /**
     * The mode used for breaking the crystal. default is `safe`
     */
    breakMode: "suicide" | "safe";
}

export class AutoCrystal {
    public enabled: boolean = true;
    public lockedPosition: Vec3 | null = null;
    private run: boolean = true;
    private started: boolean = false;
    private positions: Vec3[] | null = null;
    private target: Entity | null = null;
    private wantedPlaced: number = 0;
    private numPlaced: number = 0;
    private numBroke: number = 0;
    private crystalsPlaced: Set<String> = new Set();
    private backup: boolean = false;
    public placeDistance = 5;

    /**
     * Options for the `AutoCrystal` class.
     * @typedef {Object} Options
     * @property {boolean} [ignoreInventoryCheck=true] - See https://github.com/PrismarineJS/mineflayer/issues/2030.
     * @property {boolean} [autoEquip=true] - If set to true it will automatically equip an end crystal.
     * @property {boolean} [logDebug=false] - If the debug log should be emitted.
     * @property {boolean} [logErrors=false] - If errors should be logged.
     * @property {number} [damageThreshold=5] - If the damage exceeds the threshold, it will not place / break the crystal.
     * @property {string} [priority=distance] - What the bot should prefer when choosing where to place a crystal.
     * @property {number} [delay=1] - The delay in ticks between each crystal placement.
     * @property {string} placeMode - The mode to use for placing the crystal. can be `suicide` or `safe`
     * @property {string} breakMode - The mode to use for breaking the crystal. can be `suicide` or `safe`
     */
    /**
     * @param {Options} options
     * @param {Bot} bot
     */
    constructor(
        public bot: Bot,
        public options: Options = {
            autoEquip: true,
            ignoreInventoryCheck: true,
            asyncLoadPositions: true,
            logDebug: false,
            logErrors: false,
            priority: "damage",
            placeMode: "safe",
            breakMode: "safe",
            damageThreshold: 5,
            targetDamageThreshold: 2,
            crystalsPerTick: 1,
            placeDelay: 1,
            breakDelay: 1,
        }
    ) {
        this.bot.on("physicsTick", async () => {
            const player = await this.getNearestPlayer();
            if (!this.enabled && this.started) this.stop();
            else if (player && !this.started && this.enabled) this.start();
            else if (!player && this.started && this.enabled) this.stop();
        });

        this.bot.on("entitySpawn", (entity) => {
            if (entity.name?.includes("crystal")) {
                this.numPlaced++;
            }
        });
        this.bot.on("entityGone", (entity) => {
            if (entity.name?.includes("crystal")) {
                this.numBroke++;
                // this.updatePlaced(entity.position, false)
            }
        });
        this.bot.on("AutoCrystalError", console.error);
        this.reportPlaced();
    }

    public getTarget(): Entity | null {
        return this.target;
    }

    /**
     * Emits the debug log event with the specified message.
     * @param {string} message The message to be emitted.
     * @param {Object} options The options for the debug method.
     * @returns {void}
     * @memberof AutoCrystal
     * @private
     */
    private debug(message: string, options?: DebugOptions): void {
        if (!this.options.logDebug) return;
        if (!options) console.log(`[AutoCrystal] ${message}`);
        else if (options.useTime) console.time(`[AutoCrystal] ${message}`);
        else if (options.useTimeEnd) console.timeEnd(`[AutoCrystal] ${message}`);
    }

    /**
     * Shortcut for getting the damage for an entity.
     * @param {Entity} entity The entity to get the damage for.
     * @param {Vec3} position The position of the explosion.
     * @returns {number} The estimated damage the entity would recieve.
     * @memberof AutoCrystal
     * @private
     */
    private getDamage(entity: Entity, position: Vec3): number {
        return this.bot.getExplosionDamages(entity, position, 6, false) ?? 0;
    }

    private selfDamage(position: Vec3): number {
        return this.bot.selfExplosionDamages(position, 6, false) ?? 0;
    }

    private getPosition(): Vec3 {
        return !!this.lockedPosition ? this.lockedPosition : this.bot.entity.position;
    }

    private updatePlaced(position: Vec3, add: boolean): void {
        add ? this.crystalsPlaced.add(position.toString()) : this.crystalsPlaced.delete(position.toString());
        // console.log("updating list, action:", add ? `adding ${position}`: `removing ${position}`, "   Before size?:", size, "   after size?:", this.crystalsPlaced.size)
        return;
    }

    public filterPositions(positions: Vec3[]) {
        positions = positions.filter((block) => !this.crystalsPlaced.has(block.toString()));
        if (this.options.placeMode === "safe" && this.bot.game.difficulty !== "peaceful" && this.bot.game.gameMode !== "creative") {
            positions = positions.filter((pos) => {
                const damage = this.selfDamage(pos.offset(0, 1, 0));
                return damage <= this.options.damageThreshold! || damage < this.bot.health;
            });
        }
        // positions = positions.filter(pos => this.getDamage(entity, pos.offset(0, 1, 0)) > (this.options.targetDamageThreshold ?? 2))

        return positions;
    }
    /**
     * Finds the best position to place the crystal on to.
     * @async
     * @param {Vec3} position Vec3 position.
     * @returns {Vec3} The position to place the crystal on.
     * @memberof AutoCrystal
     * @private
     */
    private async findPosition(
        entity: Entity,
        number: number = 1,
        backup: boolean = this.options.useBackupPosAlgorithm ?? false
    ): Promise<Vec3[] | null> {
        if (!this.enabled) return null;
        // const entity_position = entity.position.clone()
        const entity_position = entity.position.clone();
        // const entity_position = new Vec3(Math.round(x), Math.round(y), Math.round(z));

        let positions = backup ? await oldFindPosition(this, entity) : await testFindPosition(this, entity);

        positions = this.filterPositions(positions);

        if (!positions || positions.length === 0) return null;

        if (this.options.priority === "distance") {
            positions = positions.sort((a, b) => {
                return (
                    b.distanceTo(entity_position) -
                    b.distanceTo(entity_position) -
                    (a.distanceTo(entity_position) - a.distanceTo(entity_position))
                );
            });

            return positions.slice(0, number);
        }

        if (this.options.priority === "damage") {
            const arr = positions.map((pos) => {
                return {
                    position: pos,
                    selfDamage: this.selfDamage(pos.offset(0.5, 1, 0.5)),
                    enemyDamage: this.getDamage(entity, pos.offset(0.5, 1, 0.5)),
                };
            });

            // check if there is an explosion that would kill the enemy
            const killPosition = arr.find((pos) => {
                return pos.enemyDamage >= entity.health!;
            });

            // use that position so the whole array doesn't have to be sorted
            if (killPosition) return [killPosition.position];
            // console.log(arr, arr.length)
            // let bestPositions = arr
            let bestPositions = arr.filter((place) => place.selfDamage < place.enemyDamage);
            bestPositions = arr.filter((place) => place.enemyDamage > this.options.targetDamageThreshold!);
            // console.log(bestPositions, bestPositions.length)
            bestPositions = bestPositions.sort(function (a, b) {
                //care more about enemy damage than self damage
                return b.enemyDamage - a.enemyDamage; // - (b.selfDamage - a.selfDamage)

                //b.enemyDamage - b.selfDamage- (a.enemyDamage - a.selfDamage);
            });

            // if (backup) {
            //     if (!this.options.placeDelay || this.options.placeDelay < 1) this.options.placeDelay = 1
            // }
            // if (!backup) {
            //     if (!this.options.placeDelay || this.options.placeDelay >= 1) this.options.placeDelay = 0
            // }

            this.backup = backup;

            // console.log(bestPositions.slice(0, number + 2).map((bestPos) => ` enemy: ${bestPos.enemyDamage} self: ${bestPos.selfDamage} pos: ${bestPos.position}`))
            // bestPositions = bestPositions.filter(b => b.position.y = Math.round(this.target!.position.y))
            if (bestPositions.length === 0 && !backup) {
                return await this.findPosition(entity, number, true);
            } else if (bestPositions.length === 0 && backup) {
                return null;
            }

            const bestPosition = bestPositions.slice(0, number);
            return bestPosition.map((bestPos) => bestPos.position);
        }

        if (!this.options.priority || this.options.priority === "none") {
            return positions.slice(0, number);
        }

        return null;
    }

    private async *placeCrystalGenerator(positions: Vec3[]) {
        for (const pos of positions) {
            yield await this.placeCrystal(pos, positions.indexOf(pos));
        }
    }

    /**
     * Places the crystal on the specified position.
     * @async
     * @param {Vec3} position Vec3 position.
     * @returns {boolean} A boolean indicating if the crystal was placed.
     * @memberof AutoCrystal
     * @private
     */
    private async placeCrystal(position: Vec3, number: number): Promise<Entity | null> {
        this.wantedPlaced++;
        const crystal =
            Object.values(this.bot.entities).find(
                (e) => (e.name?.includes("crystal") ?? false) && this.crystalsPlaced.has(e.position.toString())
            ) ?? null;
        if (!crystal) {
            const block = this.bot.blockAt(position);
            if (!(block && ["bedrock", "obsidian"].includes(block?.name))) return null;
            try {
                // this.bot.lookAt(block.position);
                //

                this.placeEntityWithOptions(block, new Vec3(0, 1, 0), { forceLook: "ignore" });
                this.updatePlaced(position.offset(0.5, 1, 0.5), true);

                console.log(`PLACED on ${number}. Mode: ${this.backup ? "backup" : "normal"}  Crystal? ${!!crystal}`);
                await this.breakCrystal();
                return null;
            } catch (err) {
                const newCrystal = Object.values(this.bot.entities).find(
                    (e) => (e.name?.includes("crystal") ?? false) && this.crystalsPlaced.has(e.position.toString())
                );
                console.log(`ERROR on ${number}. Mode: ${this.backup ? "backup" : "normal"}  Crystal? ${!!newCrystal}, error? ${err}`);
                // console.log(err)
                // console.log("failed to place, placed crystal count: ", this.crystalsPlaced.size);
                // if (this.backup)
                // return this.bot.nearestEntity((entity) => (entity.name?.includes("crystal") ?? false));
                // console.log(position);
                // this.updatePlaced(position, false)
                if (this.options.logErrors) this.bot.emit("AutoCrystalError", err);
                return null;
            }

            // && crystal.position.distanceTo(this.bot.entity.position) <= Math.pow(this.options.breakDistance!, 2)
        } else {
            return crystal;
            // return entity;
        }
    }

    /**
     * Breaks the nearest crystal
     * @async
     * @param {Entity} entity The crystal to break.
     * @returns {boolean} A boolean indicating if the crystal was broken.
     * @memberof AutoCrystal
     * @private
     */
    private async breakCrystal(crystal?: Entity | null): Promise<boolean> {
        if (!this.enabled) {
            return false;
        }
        if (!crystal) crystal = this.bot.nearestEntity((entity) => entity.name?.includes("crystal") ?? false); //&& this.crystalsPlaced.has(entity.position.toString()));
        if (crystal) {
            const damage = this.selfDamage(crystal.position);

            if (
                this.options.breakMode === "safe" &&
                this.bot.game.difficulty !== "peaceful" &&
                this.bot.game.gameMode !== "creative" &&
                (damage >= this.options.damageThreshold! || damage > this.bot.health)
            ) {
                console.log(this.bot.game.gameMode);
                console.log("hm?");
                return false;
            }

            await sleep(50 * this.options.breakDelay!);
            this.bot.lookAt(crystal.position, true);
            this.bot.attack(crystal);
            this.updatePlaced(crystal.position.offset(-0.5, -1, -0.5), false);
            return true;
        } else {
            return false;
        }
    }

    /**
     * Gets the nearest player
     * @async
     * @returns {Player} The nearest player entity object.
     * @returns {null} If no player is found.
     * @memberof AutoCrystal
     * @private
     */
    private async getNearestPlayer(): Promise<Entity | null> {
        if (!this.enabled) return null;

        const player = this.bot.nearestEntity(
            (entity) => entity.type === "player" && entity.position.distanceTo(this.bot.entity.position) <= this.options.playerDistance! * 2
        );

        return player;
    }

    /**
     * Gets holes near the bot.
     * @async
     * @returns {Vec3[]} An array of Vec3 positions
     * @memberof AutoCrystal
     */
    async getHoles(position?: Vec3): Promise<Vec3[]> {
        let holes: Vec3[] = [];
        console.log(position);
        const blocks = this.bot.findBlocks({
            point: position ?? this.bot.entity.position,
            maxDistance: 10,
            count: 2000,
            matching: (block) => block.name === "bedrock",
        });

        for (let index = 0; index < blocks.length; index++) {
            const block = blocks[index];

            if (
                this.bot.blockAt(block.offset(0, 1, 0))?.name === "air" &&
                this.bot.blockAt(block.offset(0, 2, 0))?.name === "air" &&
                this.bot.blockAt(block.offset(0, 3, 0))?.name === "air" &&
                this.bot.blockAt(block.offset(1, 1, 0))?.name === "bedrock" &&
                this.bot.blockAt(block.offset(0, 1, 1))?.name === "bedrock" &&
                this.bot.blockAt(block.offset(-1, 1, 0))?.name === "bedrock" &&
                this.bot.blockAt(block.offset(0, 1, -1))?.name === "bedrock"
            )
                holes.push(block);
        }

        return holes;
    }

    private async placeEntityWithOptions(referenceBlock: Block, faceVector: Vec3, options: Partial<genericPlaceOptions>): Promise<void> {
        if (!this.bot.heldItem) throw new Error("must be holding an item to place an entity");
        if (!this.bot.heldItem?.name.includes("crystal")) throw new Error("must be holding an end crystal to crystal pvp.");

        await this.bot._genericPlace(referenceBlock, faceVector, options);

        // this.bot.swingArm(undefined);

        const dest = referenceBlock.position.plus(faceVector);

        // const entity = await this.waitForEntitySpawn("end_crystal", dest);

        return;
    }

    waitForEntitySpawn(name: string, placePosition: Vec3): Promise<Entity> {
        const maxDistance = 2;
        let mobName = name;
        if (name === "end_crystal") {
            if (this.bot.supportFeature("enderCrystalNameEndsInErNoCaps")) {
                mobName = "ender_crystal";
            } else if (this.bot.supportFeature("entityNameLowerCaseNoUnderscore")) {
                mobName = "endercrystal";
            } else if (this.bot.supportFeature("enderCrystalNameNoCapsWithUnderscore")) {
                mobName = "end_crystal";
            } else {
                mobName = "EnderCrystal";
            }
        }

        return new Promise((resolve, reject) => {
            const listener = (entity: Entity) => {
                const dist = entity.position.distanceTo(placePosition);
                if (entity.name === mobName && dist < maxDistance) {
                    //@ts-expect-error
                    this.bot.emit("entityPlaced", entity);
                    resolve(entity);
                }
                this.bot.off("entitySpawn", listener);
            };

            setTimeout(() => {
                this.bot.off("entitySpawn", listener);
                reject(new Error("Failed to place entity"));
            }, 75); // reject after 200ms

            this.bot.on("entitySpawn", listener);
        });
    }

    private async getPositions(): Promise<void> {
        if (!this.started || !this.enabled) return;
        this.debug(`executing findPosition took`, {
            useTime: true,
        });

        if (this.target) this.positions = await this.findPosition(this.target, this.options.crystalsPerTick);
        this.debug(`executing findPosition took`, {
            useTimeEnd: true,
        });
    }

    private async reportPlaced() {
        // if (this.started || !this.enabled) return
        while (true) {
            const num = this.numPlaced;
            const want = this.wantedPlaced;
            const broke = this.numBroke;
            const pause = 1000;
            await sleep(pause);
            const placed = this.numPlaced - num;
            const wanted = this.wantedPlaced - want;
            const broken = this.numBroke - broke;
            if (this.enabled) {
                if (placed !== 0)
                    console.log(
                        `Wanted ${wanted} crystals placed. Placed ${placed} crystals in ${pause} ms. Broke ${broken} crystals. ${
                            (placed / pause) * 1000
                        } pCPS. ${(broken / pause) * 1000} bCPS. ${this.crystalsPlaced.size} Logged Placements.`
                    );
                else
                    console.log(
                        `Wanted ${wanted} crystals placed. Placed 0 crystals. Attempted to break ${broken} crystals. \nTotal placed size: ${this.crystalsPlaced.size} \ntarget: ${this.target?.username} positions found: ${this.positions?.length}`
                    );
                if (this.crystalsPlaced.size === 0 && this.target) this.crystalsPlaced.clear();
            }
        }
    }

    /**
     * Starts the auto crystal
     * @async
     * @returns {Promise<void>}
     * @memberof AutoCrystal
     * @private
     */
    private async start(): Promise<void> {
        if (this.started || !this.enabled) return;
        this.started = true;

        // loop to start the auto crystal
        while (this.run) {
            // if (this.bot.autoEat.isEating) {
            //     await sleep(50);
            //     continue;
            // }
            const time = performance.now();
            this.target = await this.getNearestPlayer();
            const crystal = this.bot.inventory.items().find((item) => item.name.includes("crystal"));

            if (this.target && (crystal || this.bot.heldItem?.name.includes("crystal"))) {
                // we equip an end crystal to the main hand if we don't have one equipped
                if (!this.bot.heldItem || this.bot.heldItem?.name !== crystal?.name) {
                    const requiresConfirmation = this.bot.inventory.requiresConfirmation;
                    if (this.options.ignoreInventoryCheck) {
                        this.bot.inventory.requiresConfirmation = false;
                    }

                    await this.bot.equip(crystal!, "hand");
                    this.bot.inventory.requiresConfirmation = requiresConfirmation;
                }

                //Begin loading positions.
                this.options.asyncLoadPositions ? this.getPositions() : await this.getPositions();
                try {
                    await sleep(50 * this.options.placeDelay! - (performance.now() - time));
                    if (this.positions) {
                        this.debug(`placing and breaking crystals took`, {
                            useTime: true,
                        });
                        // await Promise.all(this.positions.map(async pos => {
                        //     const crystal = await this.placeCrystal(pos, this.positions?.indexOf(pos) ?? 100);
                        //     if (!!crystal) {
                        //         await this.breakCrystal(crystal);
                        //     }
                        // }));
                        for await (const crystal of this.placeCrystalGenerator(this.positions)) {
                            // console.log(`called on ${i}`);
                            if (!!crystal) {
                                await this.breakCrystal(crystal);
                            }
                        }

                        this.debug(`placing and breaking crystals took`, {
                            useTimeEnd: true,
                        });
                    }
                } catch (error) {
                    console.log("error", error);
                    this.run = false;
                    if (this.options.logErrors) this.bot.emit("AutoCrystalError", error);
                }
            } else {
                this.run = false;
            }
        }

        this.started = false;
        this.run = true;
    }

    /**
     * Stops the auto crystal
     * @async
     * @returns {Promise<void>}
     * @memberof AutoCrystal
     * @private
     */
    private async stop(): Promise<void> {
        if (!this.enabled) return;
        this.run = false;
    }

    /**
     * Disables the AutoCrystal
     * @returns {boolean}
     * @memberof AutoCrystal
     */
    disable(): boolean {
        this.enabled = false;
        this.run = false;
        return true;
    }

    /**
     * Enables the AutoCrystal
     * @returns {boolean}
     * @memberof AutoCrystal
     */
    enable(): boolean {
        if (this.started) return false;
        this.enabled = true;
        this.run = true;
        return true;
    }

    lockPosition(): boolean {
        this.lockedPosition = this.bot.entity.position;
        return true;
    }
}
