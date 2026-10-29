import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);

/** 방 비밀번호 원문은 저장·동기화하지 않고 서버 메모리에 salt와 scrypt 결과만 보관한다. */
export class RoomSettings {
  readonly title: string;
  readonly privateRoom: boolean;
  private salt?: Buffer;
  private digest?: Buffer;

  constructor(title: unknown, privateRoom: unknown) {
    if (
      title !== undefined &&
      (typeof title !== "string" ||
        [...title.trim()].length < 1 ||
        [...title.trim()].length > 20 ||
        /[\p{Cc}\p{Cf}]/u.test(title))
    )
      throw new Error("방 이름은 1~20자로 입력해 주세요.");
    if (privateRoom !== undefined && typeof privateRoom !== "boolean")
      throw new Error("공개 설정을 확인해 주세요.");
    this.title = typeof title === "string" ? title.trim() : "함께 살아남아요";
    this.privateRoom = privateRoom === true;
  }

  async initialize(password: unknown): Promise<void> {
    if (!this.privateRoom) return;
    if (!this.validPassword(password))
      throw new Error("비밀번호는 4~32자로 입력해 주세요.");
    this.salt = randomBytes(16);
    this.digest = (await derive(password, this.salt, 32)) as Buffer;
  }

  async verify(password: unknown): Promise<boolean> {
    if (!this.privateRoom) return true;
    if (!this.validPassword(password) || !this.salt || !this.digest)
      return false;
    const actual = (await derive(password, this.salt, 32)) as Buffer;
    return timingSafeEqual(this.digest, actual);
  }

  private validPassword(value: unknown): value is string {
    return (
      typeof value === "string" &&
      [...value].length >= 4 &&
      [...value].length <= 32 &&
      !/[\p{Cc}\p{Cf}]/u.test(value)
    );
  }
}
