import { WORLD, type Rect } from "@playground/shooting-shared";

export interface Point {
  x: number;
  y: number;
}
export interface RayHit {
  fraction: number;
  nx: number;
  ny: number;
}
export const distanceSquared = (a: Point, b: Point): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** 빠른 저격탄도 대상 사이를 건너뛰지 않도록 이동 선분 전체로 충돌한다. */
export function segmentCircle(
  x: number,
  y: number,
  dx: number,
  dy: number,
  target: Point,
  radius: number,
): number | undefined {
  const px = x - target.x,
    py = y - target.y;
  const a = dx * dx + dy * dy,
    b = 2 * (px * dx + py * dy),
    c = px * px + py * py - radius * radius;
  if (c <= 0) return 0;
  if (a === 0) return undefined;
  const determinant = b * b - 4 * a * c;
  if (determinant < 0) return undefined;
  const at = (-b - Math.sqrt(determinant)) / (2 * a);
  return at >= 0 && at <= 1 ? at : undefined;
}

/** 벽 면의 법선과 진입 지점을 반환하며 탄환 충돌·시야·길찾기가 같은 경계를 사용한다. */
export function segmentRect(
  x: number,
  y: number,
  dx: number,
  dy: number,
  rect: Rect,
  padding = 0,
): RayHit | undefined {
  let enter = 0,
    leave = 1,
    nx = 0,
    ny = 0;
  for (const axis of [0, 1]) {
    const start = axis === 0 ? x : y,
      delta = axis === 0 ? dx : dy;
    const low = (axis === 0 ? rect.x : rect.y) - padding;
    const high = low + (axis === 0 ? rect.width : rect.height) + padding * 2;
    if (Math.abs(delta) < 1e-9) {
      if (start < low || start > high) return undefined;
      continue;
    }
    let near = (low - start) / delta,
      far = (high - start) / delta;
    const normal = delta > 0 ? -1 : 1;
    if (near > far) [near, far] = [far, near];
    if (near > enter) {
      enter = near;
      nx = axis === 0 ? normal : 0;
      ny = axis === 1 ? normal : 0;
    }
    leave = Math.min(leave, far);
    if (enter > leave) return undefined;
  }
  return enter >= 0 && enter <= 1 ? { fraction: enter, nx, ny } : undefined;
}

/** 몬스터·탄환 수가 늘어도 모든 쌍을 비교하지 않도록 전투 공간을 작은 셀로 나눈다. */
export class SpatialGrid<T extends Point> {
  private readonly cells = new Map<number, T[]>();
  private readonly size = 96;
  private readonly columns = 32;
  rebuild(values: Iterable<T>): void {
    for (const cell of this.cells.values()) cell.length = 0;
    for (const item of values) {
      const key =
        Math.floor(item.y / this.size) * this.columns +
        Math.floor(item.x / this.size);
      const cell = this.cells.get(key);
      if (cell) cell.push(item);
      else this.cells.set(key, [item]);
    }
  }
  query(x: number, y: number, radius: number): T[] {
    const result: T[] = [];
    for (
      let row = Math.max(0, Math.floor((y - radius) / this.size));
      row <= Math.min(31, Math.floor((y + radius) / this.size));
      row++
    ) {
      for (
        let col = Math.max(0, Math.floor((x - radius) / this.size));
        col <= Math.min(this.columns - 1, Math.floor((x + radius) / this.size));
        col++
      ) {
        const cell = this.cells.get(row * this.columns + col);
        if (cell) result.push(...cell);
      }
    }
    return result;
  }
}

/** 방 지형의 접근 가능성과 추격 경로를 같은 격자로 계산한다. 반경별 흐름장은 팀원마다 공유한다. */
export class Navigation {
  readonly cell = 20;
  readonly columns = WORLD.width / this.cell;
  readonly rows = WORLD.height / this.cell;
  private readonly walls: readonly Rect[];
  private readonly masks = new Map<number, Uint8Array>();
  private readonly fields = new Map<string, Int16Array>();
  private age = 1;
  constructor(walls: readonly Rect[]) {
    this.walls = walls;
  }
  visible(from: Point, target: Point, radius: number): boolean {
    return !this.walls.some((wall) =>
      segmentRect(
        from.x,
        from.y,
        target.x - from.x,
        target.y - from.y,
        wall,
        radius + 0.5,
      ),
    );
  }
  connected(): boolean {
    const blocked = this.mask(20),
      field = this.build({ x: WORLD.width / 2, y: WORLD.height / 2 }, blocked);
    return blocked.every((value, index) => value !== 0 || field[index] >= 0);
  }
  refresh(dt: number, _targets: readonly (Point & { id: string })[]): void {
    this.age += dt;
    if (this.age < 0.2) return;
    this.age = 0;
    this.fields.clear();
  }
  direction(from: Point, target: Point & { id: string }, radius = 20): Point {
    if (this.visible(from, target, radius)) return target;
    const blocked = this.mask(radius),
      key = `${radius}:${target.id}`;
    let field = this.fields.get(key);
    if (!field) {
      field = this.build(target, blocked);
      this.fields.set(key, field);
    }
    const cx = Math.floor(from.x / this.cell),
      cy = Math.floor(from.y / this.cell);
    let best = Infinity,
      destination: Point = from;
    // 벽 모서리를 대각선으로 가로질러 걸리지 않도록 실제 반경으로 선분의 통과 가능성까지 확인한다.
    for (let y = Math.max(0, cy - 3); y <= Math.min(this.rows - 1, cy + 3); y++)
      for (
        let x = Math.max(0, cx - 3);
        x <= Math.min(this.columns - 1, cx + 3);
        x++
      ) {
        const index = y * this.columns + x;
        if (blocked[index] || field[index] < 0) continue;
        const point = {
          x: x * this.cell + this.cell / 2,
          y: y * this.cell + this.cell / 2,
        };
        const travel = Math.sqrt(distanceSquared(from, point));
        if (travel < 1 || !this.visible(from, point, radius)) continue;
        const score = field[index] + travel / this.cell;
        if (score < best) {
          best = score;
          destination = point;
        }
      }
    return destination;
  }
  private mask(radius: number): Uint8Array {
    const existing = this.masks.get(radius);
    if (existing) return existing;
    const mask = new Uint8Array(this.columns * this.rows);
    for (let y = 0; y < this.rows; y++)
      for (let x = 0; x < this.columns; x++) {
        const px = x * this.cell + this.cell / 2,
          py = y * this.cell + this.cell / 2;
        mask[y * this.columns + x] = Number(
          px < WORLD.border + radius + 1 ||
            px > WORLD.width - WORLD.border - radius - 1 ||
            py < WORLD.border + radius + 1 ||
            py > WORLD.height - WORLD.border - radius - 1 ||
            this.walls.some(
              (w) =>
                px >= w.x - radius - 1 &&
                px <= w.x + w.width + radius + 1 &&
                py >= w.y - radius - 1 &&
                py <= w.y + w.height + radius + 1,
            ),
        );
      }
    this.masks.set(radius, mask);
    return mask;
  }
  private build(target: Point, blocked: Uint8Array): Int16Array {
    const result = new Int16Array(blocked.length).fill(-1);
    let start = 0,
      best = Infinity;
    // 플레이어가 벽에 붙어 있으면 큰 보스가 도달 가능한 가장 가까운 셀을 목표로 삼는다.
    for (let index = 0; index < blocked.length; index++)
      if (!blocked[index]) {
        const distance =
          ((index % this.columns) * this.cell + this.cell / 2 - target.x) ** 2 +
          (Math.floor(index / this.columns) * this.cell +
            this.cell / 2 -
            target.y) **
            2;
        if (distance < best) {
          best = distance;
          start = index;
        }
      }
    const queue = new Int16Array(result.length);
    let head = 0,
      tail = 0;
    queue[tail++] = start;
    result[start] = 0;
    while (head < tail) {
      const current = queue[head++],
        x = current % this.columns,
        y = Math.floor(current / this.columns);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= this.columns || ny >= this.rows) continue;
        const next = ny * this.columns + nx;
        if (!blocked[next] && result[next] < 0) {
          result[next] = result[current] + 1;
          queue[tail++] = next;
        }
      }
    }
    return result;
  }
}
