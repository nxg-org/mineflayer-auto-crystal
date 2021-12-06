import { Bot } from "mineflayer"
const Entity = require("prismarine-entity")
import * as conv from "./conversions"
import md from "minecraft-data"
import { Vec3 } from "vec3"
import { randomUUID } from "crypto"


const animationEvents = {
  0: 'entitySwingArm',
  1: 'entityHurt',
  2: 'entityWake',
  3: 'entityEat',
  4: 'entityCriticalEffect',
  5: 'entityMagicCriticalEffect'
}

const entityStatusEvents = {
  2: 'entityHurt',
  3: 'entityDead',
  6: 'entityTaming',
  7: 'entityTamed',
  8: 'entityShakingOffWater',
  10: 'entityEatingGrass'
}


const defaultVelocity = new Vec3(0, 0, 0)

let lut: any[] = [];
for (var i = 0; i < 256; i++) {
    lut[i] = (i < 16 ? "0" : "") + i.toString(16);
}

function uuid() {
    var d0 = (Math.random() * 0xffffffff) | 0;
    var d1 = (Math.random() * 0xffffffff) | 0;
    var d2 = (Math.random() * 0xffffffff) | 0;
    var d3 = (Math.random() * 0xffffffff) | 0;
    return (
        lut[d0 & 0xff] +
        lut[(d0 >> 8) & 0xff] +
        lut[(d0 >> 16) & 0xff] +
        lut[(d0 >> 24) & 0xff] +
        "-" +
        lut[d1 & 0xff] +
        lut[(d1 >> 8) & 0xff] +
        "-" +
        lut[((d1 >> 16) & 0x0f) | 0x40] +
        lut[(d1 >> 24) & 0xff] +
        "-" +
        lut[(d2 & 0x3f) | 0x80] +
        lut[(d2 >> 8) & 0xff] +
        "-" +
        lut[(d2 >> 16) & 0xff] +
        lut[(d2 >> 24) & 0xff] +
        lut[d3 & 0xff] +
        lut[(d3 >> 8) & 0xff] +
        lut[(d3 >> 16) & 0xff] +
        lut[(d3 >> 24) & 0xff]
    );
}


export class EntityController {
  private entitiesArray;
  private objects;
    constructor(public bot: Bot) {
      this.objects = md(this.bot.version).objects
      this.entitiesArray = md(this.bot.version).entitiesArray
    }


  setEntityData (entity: typeof Entity, type: number, entityData: any) {
    if (entityData === undefined) {
      entityData = this.entitiesArray.find(entity => entity.internalId === type)
    }
    if (entityData) {
      entity.mobType = entityData.displayName
      entity.objectType = entityData.displayName
      entity.displayName = entityData.displayName
      entity.entityType = entityData.id
      entity.name = entityData.name
      entity.kind = entityData.category
      entity.height = entityData.height
      entity.width = entityData.width
    } else {
      // unknown entity
      entity.type = 'other'
      entity.entityType = type
      entity.mobType = 'unknown'
      entity.displayName = 'unknown'
      entity.name = 'unknown'
      entity.kind = 'unknown'
    }
  }


  generateEntity(id: number, type: number, position: Vec3, pitch: number = 0, yaw: number = 0, velocity: Vec3 = defaultVelocity, objectData: any = 0) {
    const packet = {
      entityId: id,
      objectUUID: randomUUID(),
      type,
      x: position.x,
      y: position.y,
      z: position.z,
      pitch,
      yaw,
      objectData, 
      velocityX: velocity.x,
      velocityY: velocity.y,
      velocityZ: velocity.z
    }
    return this.spawnEntity(packet)
  }



  fetchEntity (id: number) {
    return this.bot.entities[id] || (this.bot.entities[id] = new Entity(id))
  }

  checkForEntity(id: number): boolean {
    return !!this.bot.entities[id] 
  }

  spawnEntity(packet: any): typeof Entity {
    // spawn object/vehicle
    if(this.checkForEntity(packet.entityId)) return this.fetchEntity(packet.entityId)
  
    const entity = this.fetchEntity(packet.entityId)
    const entityData = this.objects[packet.type]

    entity.type = 'object'
    this.setEntityData(entity, packet.type, entityData)

    if (this.bot.supportFeature('fixedPointPosition')) {
      entity.position.set(packet.x / 32, packet.y / 32, packet.z / 32)
    } else if (this.bot.supportFeature('doublePosition')) {
      entity.position.set(packet.x, packet.y, packet.z)
    }

    //@ts-expect-error
    entity.uuid = packet.objectUUID
    entity.yaw = conv.fromNotchianYawByte(packet.yaw)
    entity.pitch = conv.fromNotchianPitchByte(packet.pitch)
    //@ts-expect-error
    entity.objectData = packet.objectData
    this.bot.emit('entitySpawn', entity)
    return entity;
  }


  destroyEntities(...entityIds: number[]) {
    // destroy entity
    
      for (const id of entityIds) {
      if(!this.checkForEntity(id)) continue
      const entity = this.fetchEntity(id)
      entity.isValid = false
      delete this.bot.entities[id]
      //this.bot.emit('entityGone', entity)
    };
  }

  invalidateEntities(...entityIds: number[]) {
    entityIds.forEach((id) => {
      const entity = this.fetchEntity(id)
      entity.isValid = false
    })
  }


  updateEntityAttributes(packet: { entityId: any; properties: any }) {
    const entity = this.fetchEntity(packet.entityId)
    if (!entity.attributes) entity.attributes = {}
    for (const prop of packet.properties) {
      entity.attributes[prop.key] = {
        value: prop.value,
        modifiers: prop.modifiers
      }
    }
    this.bot.emit('entityAttributes', entity)
  }

}

