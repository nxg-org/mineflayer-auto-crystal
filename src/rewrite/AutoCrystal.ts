import { Bot } from "mineflayer";
import { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { testFindPosition, oldFindPosition, predictivePositioning } from "../testPlacement";
import { genericPlaceOptions } from "../types";
import { promisify } from "util";
import { Block } from "prismarine-block";
import { EntityController } from "./EntityController";
const sleep = promisify(setTimeout);

export interface AutoCrystalRewriteOptions {
    placementsPerTick: number;
    tpsSync: boolean;
    useOffhand: boolean;
    placementPriority: "damage" | "distance";
    useBackupPosAlgorithm: boolean;
    placeMode: "safe" | "suicide";
    breakMode: "safe" | "suicide";
    maxSelfDamage: number;
    minTargetDamage: number;
    ignoreInventoryCheck: boolean;
    asyncLoadPositions: boolean;
    placeDelay: number;
    placeDistance: number;
    breakDelay: number;
    breakDistance: number;
    logErrors: boolean;
}

export class AutoCrystalRewrite {
    public target: Entity | null = null;
    public placementsPerTick: number;
    public tpsSync: boolean;
    public useOffhand: boolean;
    public placementPriority: "damage" | "distance";
    public useBackupPosAlgorithm: boolean;
    public enabled: boolean = true;
    public placeMode: "safe" | "suicide";
    public placeDelay: number;
    public placeDistance: number;
    public breakMode: "safe" | "suicide";
    public breakDelay: number;
    public breakDistance: number;
    public maxSelfDamage: number;
    private usingBackup: boolean = false;
    public minTargetDamage: number;
    public isRunning: boolean = false;
    private asyncLoadPositions: boolean;
    private placementPositions: Vec3[] | null = null;

    private wantedPlaced: number = 0;
    private numPlaced: number = 0;
    private numBroke: number = 0;

    private logErrors: boolean;

    private lastAttackedId: number = 0;
    private lastSpawnedId: number = 0;

    private entityController: EntityController;

    private lastPlacementTime = performance.now();
    private lastBreakTime = performance.now();

    private lastSpawnTime = performance.now();
    private lastDestroyTime = performance.now();

    public holeBlocks = ["bedrock"];

    constructor(public bot: Bot, options?: Partial<AutoCrystalRewriteOptions>) {
        this.bot = bot;
        this.placementsPerTick = options?.placementsPerTick ?? 2
        this.tpsSync = options?.tpsSync ?? false;
        this.useOffhand = options?.useOffhand ?? false;
        this.placementPriority = options?.placementPriority ?? "damage";
        this.useBackupPosAlgorithm = options?.useBackupPosAlgorithm ?? false;
        this.placeMode = options?.placeMode ?? "safe";
        this.placeDelay = options?.placeDelay ?? 1;
        this.placeDistance = options?.placeDistance ?? 5;
        this.breakMode = options?.breakMode ?? "safe";
        this.breakDelay = options?.breakDelay ?? 0;
        this.breakDistance = options?.breakDistance ?? 5;
        this.maxSelfDamage = options?.maxSelfDamage ?? 3;
        this.minTargetDamage = options?.minTargetDamage ?? 2;
        this.asyncLoadPositions = options?.asyncLoadPositions ?? true;
        this.entityController = new EntityController(bot);

        this.logErrors = options?.logErrors ?? false;
        this.bot.on("AutoCrystalError", console.log);
        // this.bot.on("entitySpawn", (entity) => {

        //     if (entity.name?.includes("crystal")) {
        //         this.lastSpawnedId = entity.id
        //         const time = performance.now()
        //         console.log(`Entity spawned.\n${(time - this.lastSpawnTime).toFixed(2)} ms since last spawn.\n${(time - this.lastPlacementTime).toFixed(2)} ms since last placement.\n`)
        //         this.lastSpawnTime = time
        //     }

        //     // if (entity.name?.includes("crystal") && entity.position.distanceTo(this.bot.entity.position) <= this.breakDistance)
        //     //     this.breakCrystal(entity)

        // })
        // this.bot.on("entityGone", (entity) => {
        //     if (entity.name?.includes("crystal")) {
        //         const time = performance.now()
        //         console.log(`Entity died.\n${(time - this.lastDestroyTime).toFixed(2)} ms since last death.\n${(time - this.lastBreakTime).toFixed(2)} ms since last break.\n`)
        //         this.lastDestroyTime = time
        //     }
        // })

        // this.bot.on("entitySwingArm", entity => {
        //     if (entity !== this.bot.entity) {
        //         const time = performance.now()
        //         this.lastPlacementTime = time
        //         this.lastBreakTime = time
        //     }
        // })

        if (this.enabled) {
            this.enable();
            this.reportPlaced();
            if (this.asyncLoadPositions) this.loadPositions();
        }
    }

    async equipCrystal(): Promise<boolean> {
        if (this.bot.util.inv.getHandWithItem(this.useOffhand)?.name.includes("_crystal")) return true;
        const handName = this.useOffhand ? "off-hand" : "hand";
        const crystal = this.bot.util.inv.getAllItemsExceptCurrent(handName).find((item) => item?.name.includes("_crystal"));
        if (crystal) {
            await this.bot.equip(crystal, handName);
            //await this.bot.util.builtInsPriority({ group: "inventory", priority: 10 }, this.bot.equip, crystal, handName);
            return true;
        }
        return false;
    }

    private async equipTotem(): Promise<boolean> {
        if (this.bot.util.inv.getHandWithItem(true)?.name.includes("_crystal")) return true;
        const totem = this.bot.util.inv.getAllItemsExceptCurrent("off-hand").find((item) => item?.name.includes("totem_"));
        if (totem) {
            await this.bot.equip(totem, "off-hand");
            return true;
        }
        return false;
    }

    public async getPossiblePositions(entity?: Entity, force: boolean = false): Promise<Vec3[]> {
        const eEntity = entity ?? this.target;
        return eEntity ? (await this.findPositions(eEntity, this.placementsPerTick, force)) ?? [] : [];
    }

    private async getPositions(): Promise<void> {
        if (this.target) {
            this.placementPositions = await this.findPositions(this.target, this.placementsPerTick);
        }
    }

    private getAllCrystals(): Entity[] {
        const entities = Object.values(this.bot.entities).filter((e) => e.name?.includes("_crystal") ?? false);
        return entities;
    }

    public getHoles(pos?: Vec3, mode: "defensive" | "passive" | "aggressive" | "retreat" = "passive"): Vec3[] {
        let holes: Vec3[] = [];
        let position = pos ?? this.bot.entity.position;
        if (mode === "retreat") position = this.bot.entity.position.minus(this.bot.entity.position.minus(position));
        const blocks = this.bot.findBlocks({
            point: position,
            maxDistance: 10,
            count: 2000,
            matching: (block) => this.holeBlocks.includes(block?.name),
        });

        for (let index = 0; index < blocks.length; index++) {
            const block = blocks[index];

            if (this.isHole(block)) holes.push(block);
        }

        holes = holes.filter((hole) => hole.distanceTo(this.bot.entity.position) >= 2);

        switch (mode) {
            case "aggressive":
                holes = holes.sort((a, b) => a.distanceTo(position) - b.distanceTo(position));
                break;
            case "defensive":
                holes = holes.sort((a, b) => b.distanceTo(position) - a.distanceTo(position));
            case "passive":
                break;
            case "retreat":
                holes = holes.sort((a, b) => b.distanceTo(position) - a.distanceTo(position));
                break;
            default:
                break;
        }

        return holes;
    }

    private isHole(block: Vec3, ...extraNames: string[]) {
        const names = [...extraNames, ...this.holeBlocks];
        // console.log(
        //     this.bot.blockAt(block)?.name,
        // this.bot.blockAt(block.offset(0, 1, 0))?.name,
        // this.bot.blockAt(block.offset(0, 2, 0))?.name,
        // this.bot.blockAt(block.offset(0, 3, 0))?.name,
        // this.bot.blockAt(block.offset(1, 1, 0))?.name,
        // this.bot.blockAt(block.offset(0, 1, 1))?.name,
        // this.bot.blockAt(block.offset(-1, 1, 0))?.name,
        // this.bot.blockAt(block.offset(0, 1, -1))?.name
        // )
        return (
            this.bot.blockAt(block.offset(0, 1, 0))?.name === "air" &&
            this.bot.blockAt(block.offset(0, 2, 0))?.name === "air" &&
            this.bot.blockAt(block.offset(0, 3, 0))?.name === "air" &&
            names.includes(this.bot.blockAt(block.offset(1, 1, 0))?.name ?? "") &&
            names.includes(this.bot.blockAt(block.offset(0, 1, 1))?.name ?? "") &&
            names.includes(this.bot.blockAt(block.offset(-1, 1, 0))?.name ?? "") &&
            names.includes(this.bot.blockAt(block.offset(0, 1, -1))?.name ?? "")
        );
    }

    public isInHole(...extraNames: string[]) {
        return this.isHole(this.bot.entity.position.floored().offset(0, -1, 0), ...extraNames);
    }

    public hasCrystals() {
        if (this.bot.util.inv.getHandWithItem(this.useOffhand)?.name.includes("_crystal")) return true;
        const handName = this.useOffhand ? "off-hand" : "hand";
        return !!this.bot.util.inv.getAllItemsExceptCurrent(handName).find((item) => item?.name.includes("_crystal"));
    }

    private async reportPlaced() {
        while (this.enabled) {
            const num = this.numPlaced;
            const want = this.wantedPlaced;
            const broke = this.numBroke;
            const pause = 1000;
            await sleep(pause);
            const placed = this.numPlaced - num;
            const wanted = this.wantedPlaced - want;
            const broken = this.numBroke - broke;
            if (this.isRunning) {
                if (placed !== 0)
                    console.log(
                        `Wanted ${wanted} crystals placed. Placed ${placed} crystals in ${pause} ms. Broke ${broken} crystals. ${
                            (placed / pause) * 1000
                        } pCPS. ${(broken / pause) * 1000} bCPS. ${this.getAllCrystals().length} crystals detected.`
                    );
                else
                    console.log(
                        `Wanted ${wanted} crystals placed. Placed 0 crystals. Attempted to break ${broken} crystals. \nTotal crystals: ${Object.values(
                            this.bot.entities
                        )
                            .filter((e) => e.name?.includes("crystal"))
                            .map((c) => `${c.position}, ${c.id}`)} \ntarget: ${this.target?.username} positions found: ${
                            this.placementPositions?.length
                        }`
                    );
            }
        }
    }

    private async placeEntityNoWait(referenceBlock: Block, faceVector: Vec3, options: Partial<genericPlaceOptions>): Promise<Vec3> {
        if (!this.bot.heldItem) throw new Error("must be holding an item to place an entity");
        if (!this.bot.heldItem?.name.includes("crystal")) throw new Error("must be holding an end crystal to crystal pvp.");

        const pos = referenceBlock.position;
        await this.bot._genericPlace(referenceBlock, faceVector, options);
        this.bot.swingArm(undefined);
        const dest = pos.plus(faceVector);
        return dest;
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

            this.bot.on("entitySpawn", listener);
            setTimeout(() => {
                this.bot.off("entitySpawn", listener);
                reject(new Error("Failed to place entity"));
            }, 50); // reject after 200ms
        });
    }

    /**
     * TODO:
     *  1.  Report place wanted.
     *  2. check if crystal is already there.
     *  2a. if crystal, return crystal's position to target.
     *  2b. if no crystal, place crystal.
     *  2b1. I think I should wait.
     * @param position
     */
    private async placeCrystal(position: Vec3): Promise<Entity | boolean | null> {
        this.wantedPlaced++;
        let crystal = this.bot.nearestEntity(
            (e) => (e.name?.includes("_crystal") ?? false) && e.position.offset(-0.5, -1, -0.5).equals(position)
        );
        if (!crystal) {
            const block = this.bot.blockAt(position);
            if (!!block && ["obsidian", "bedrock"].includes(block.name)) {
                const time = performance.now();
                // await this.bot.placeEntity(this.bot.blockAt(block.position.offset(0, 0, 0))!, new Vec3(0, 1, 0));
                try {
                    await this.placeEntityNoWait(this.bot.blockAt(block.position.offset(0, 0, 0))!, new Vec3(0, 1, 0), { forceLook: "ignore"});
                    // const latestId = Number(Object.keys(this.bot.entities).sort((a, b) => Number(a) - Number(b))[0])
                    // this.entityController.generateEntity(latestId + 1, 51, position.offset(0.5, 1, 0.5))
                    this.lastPlacementTime = time;
                    this.numPlaced++;
                    return true;
                } catch (e) {
                    return null;
                }
            } else {
                return null;
            }
        } else {
            return true;
        }
    }

    private async breakCrystal(crystal?: Entity | null): Promise<boolean> {
        if (!crystal)
            crystal = this.bot.nearestEntity(
                (entity) =>
                    (entity.name?.includes("crystal") ?? false) &&
                    entity.position.distanceTo(this.bot.entity.position) <= this.breakDistance
            );
        if (crystal) {
            if (crystal.id === this.lastAttackedId) return false;
            this.lastAttackedId = crystal.id;
            const damage = this.selfDamage(crystal.position);

            if (
                this.breakMode === "safe" &&
                this.bot.game.difficulty !== "peaceful" &&
                this.bot.game.gameMode !== "creative" &&
                (damage >= this.maxSelfDamage || damage > this.bot.health)
            ) {
                return false;
            }

            await sleep(50 * this.breakDelay);
            // this.bot.lookAt(crystal.position, true);
            this.bot.attack(crystal);
            this.lastBreakTime = performance.now();
            this.entityController.destroyEntities(crystal.id);
            this.numBroke++;
            return true;
        } else {
            return false;
        }
    }

    private async loadPositions() {
        while (this.enabled) {
            this.getPositions();
            await sleep(20);
        }
    }

    public async start(): Promise<boolean> {
 
        // if (!this.enabled || this.isRunning) return false;
        this.isRunning = true
        while (this.isRunning) {
            const time = performance.now();
            this.target = await this.bot.util.filters.allButOtherBotsFilter();
            if(!this.target || !this.hasCrystals()) break;
            //Begin loading positions.
            if (!this.asyncLoadPositions) await this.getPositions();
            if (!this.placementPositions || this.placementPositions.length === 0) {
                await sleep(0);
                continue;
            }

            await this.equipCrystal();
            await sleep(50 * this.placeDelay - (performance.now() - time));
            const time1 = performance.now();
            try {
                let placed = 0;
                let failed = 0;
                if (this.placementPositions) {
                    // for (const position of this.placementPositions) {
                    //     const place = await this.placeCrystal(position);
                    //     if (place) {
                    //         placed++;
                    //         await this.breakCrystal();
                    //     } else {
                    //         failed++;
                    //     }
                    // }

                    await Promise.all(
                        this.placementPositions.map(async (pos) => {
                            const crystal = await this.placeCrystal(pos);
                            if (!!crystal) {
                                await this.breakCrystal();
                            }
                        })
                    );
                }
                // for (const entity of this.getAllCrystals()) {
                //     if (entity.position.distanceTo(this.bot.entity.position) <= this.breakDistance)
                //     await this.breakCrystal(entity)
                // }
                const duration = performance.now() - time1;
                // if (placed > 0) console.log(duration)
                // else console.log(failed, this.placementPositions)
            } catch (error) {
                console.log("error", error);
                this.isRunning = false;
                if (this.logErrors) this.bot.emit("AutoCrystalError", error);
            }
        }
        this.isRunning = false;
        return true;
    }

    private getDamage(entity: Entity, position: Vec3): number {
        return this.bot.getExplosionDamages(entity, position, 6, false) ?? 0;
    }

    private selfDamage(position: Vec3): number {
        return this.bot.selfExplosionDamages(position, 6, false) ?? 0;
    }

    public filterPositions(positions: Vec3[]) {
        if (this.placeMode === "safe" && this.bot.game.difficulty !== "peaceful" && this.bot.game.gameMode !== "creative") {
            positions = positions.filter((pos) => this.checkDamage(this.selfDamage(pos.offset(0.5, 1, 0.5))));
        }

        return positions;
    }

    public checkDamage(damage: number) {
        return damage <= this.maxSelfDamage || damage < this.bot.health;
    }

    private async findPositions(
        entity: Entity,
        number: number = 1,
        raw: boolean = false,
        backup?: boolean,
    ): Promise<Vec3[] | null> {
        backup ??= this.useBackupPosAlgorithm
        const entity_position = entity.position.clone();

    
        let positions = backup ? await testFindPosition(this, entity) : await predictivePositioning(this, entity) // await testFindPosition(this, entity)
        // let positions =  await predictivePositioning(this, entity) ;


        if (!raw) positions = this.filterPositions(positions);

        if (!positions || positions.length === 0) return null;

        if (this.placementPriority === "distance") {
            positions = positions.sort((a, b) => {
                return (
                    b.distanceTo(entity_position) -
                    a.distanceTo(entity_position) -
                    (b.distanceTo(entity_position) - a.distanceTo(entity_position))
                );
            });

            return positions.slice(0, number);
        }

        if (this.placementPriority === "damage") {
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

            let bestPositions = arr.filter((place) => place.selfDamage < place.enemyDamage);
            bestPositions = bestPositions.filter((place) => place.enemyDamage > this.minTargetDamage);
            bestPositions = bestPositions.sort(function (a, b) {
                //care more about enemy damage than self damage
                return b.enemyDamage - a.enemyDamage;
            });

            this.usingBackup = backup;
            if (bestPositions.length === 0 && !backup) {
                return await this.findPositions(entity, number, false, true);
            } else if (bestPositions.length === 0 && backup) {
                return null;
            }

            const bestPosition = bestPositions.slice(0, number);
            return bestPosition.map((bestPos) => bestPos.position);
        }

        if (!this.placementPriority || this.placementPriority === "none") {
            return positions.slice(0, number);
        }

        return null;
    }

    /**
     * Disables the AutoCrystal
     * @returns {boolean}
     * @memberof AutoCrystal
     */
    disable(): boolean {
        if (!this.isRunning) return false;
        this.enabled = false;
        this.isRunning = false;
        return true;
    }

    stop(): boolean {
        if (!this.isRunning) return false;
        this.isRunning = false;
        return true;
    }

    /**
    stop(): boolean {
        if (!this.isRunning) return false;
        this.isRunning = false;
        return true;
    }

     * Enables the AutoCrystal
     * @returns {boolean}
     * @memberof AutoCrystal
     */
    enable(): boolean {
        if (this.isRunning) return false;
        this.enabled = true;
        this.isRunning = true;
        return true;
    }

    restart() {
        this.disable();
        this.enable();
        this.reportPlaced();
        if (this.asyncLoadPositions) this.loadPositions();
    }
}
