import { cabinetPreview } from '../game/cabinetPreview';
import {
  CABINET_SKINS,
  COIN_SKINS,
  cabinetSkinById,
  coinSkinById,
  type CabinetSkin,
  type CoinSkin,
} from '../game/cosmetics';
import type { SaveStore } from './SaveStore';

export type SkinChange = {
  coinSkin: CoinSkin;
  cabinetSkin: CabinetSkin;
};

/**
 * 图鉴面板：展示筹码钱包与外观解锁状态。
 *
 * 图鉴用**筹码**购买（v3 起没有图鉴券），而筹码是玩无尽赚来的——
 * 所以图鉴是「玩得久」的长线钩子，不是通关奖励。
 * 外观只改币纹与机柜配色，不影响返值、投币消耗、推板行程或任何其他数值。
 */
export class CollectionPanel {
  private readonly panel = this.el('#collection-panel');
  private readonly button = this.el<HTMLButtonElement>('#collection-button');
  private readonly closeButton = this.el<HTMLButtonElement>('#collection-close');
  private readonly balanceCount = this.el('#ticket-count');
  private readonly coinList = this.el('#coin-skin-list');
  private readonly cabinetList = this.el('#cabinet-skin-list');
  private returnFocus: HTMLElement | null = null;
  private readonly onToggle = (event: Event) => { event.preventDefault(); this.toggle(); };
  private readonly onClose = (event: Event) => { event.preventDefault(); this.close(); };
  private readonly onPanelKey = (event: KeyboardEvent) => {
    // Keep native Space/Enter button activation; game shortcuts never receive modal keys.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = [...this.panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), [tabindex="0"]')]
      .filter(control => control.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); this.panel.focus(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  constructor(
    private readonly save: SaveStore,
    private readonly onChange: (change: SkinChange) => void,
    private readonly onVisibilityChange: (visible: boolean) => void = () => {},
    /** Report an already paid skin expense; the host must never debit it again. */
    private readonly onPurchase: (actualCost: number) => void = () => {},
  ) {
    this.button.addEventListener('click', this.onToggle);
    this.closeButton.addEventListener('click', this.onClose);
    this.panel.addEventListener('keydown', this.onPanelKey);
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-label', '图鉴');
    this.panel.tabIndex = -1;
    this.refresh();
  }

  get visible(): boolean {
    return !this.panel.hidden;
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open(this.button);
  }

  open(opener?: HTMLElement): void {
    // Safari does not focus pointer-clicked buttons, so an explicit opener owns restoration.
    this.returnFocus = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : this.button);
    this.refresh();
    this.panel.hidden = false;
    this.onVisibilityChange(true);
    this.closeButton.focus();
  }

  close(): void {
    const wasVisible = this.visible;
    this.panel.hidden = true;
    this.onVisibilityChange(false);
    if (wasVisible) {
      const target = this.returnFocus?.isConnected && this.returnFocus.getClientRects().length > 0 ? this.returnFocus : this.button;
      target.focus();
      this.returnFocus = null;
    }
  }

  dispose(): void {
    this.close();
    this.button.removeEventListener('click', this.onToggle);
    this.closeButton.removeEventListener('click', this.onClose);
    this.panel.removeEventListener('keydown', this.onPanelKey);
    // Remove dynamic button closures as well as the static dialog listeners.
    this.coinList.replaceChildren();
    this.cabinetList.replaceChildren();
  }

  /** 结算后刷新，让新到手的筹码立刻可花。 */
  refresh(): void {
    // ★ S4：这里印的是**余额**，不是 `spendable` —— 玩家得先看见自己有多少钱。
    //   但跪来的那一份不能换成图鉴，所以有脏钱时**把可用额一并标出来**，
    //   否则按钮灰着而数字看着够 ⇒ 那就是「静默拒绝」，玩家会以为界面坏了。
    this.balanceCount.textContent =
      this.save.beggedTotal > 0
        ? `余额 ${this.save.balance}（可用 ${this.save.spendable}）`
        : `余额 ${this.save.balance}`;
    this.renderList(this.coinList, 'coin', COIN_SKINS);
    this.renderList(this.cabinetList, 'cabinet', CABINET_SKINS);
  }

  private renderList(
    container: HTMLElement,
    kind: 'coin' | 'cabinet',
    skins: Array<CoinSkin | CabinetSkin>,
  ): void {
    container.innerHTML = '';
    const selectedId =
      kind === 'coin' ? this.save.snapshot.selectedCoinSkin : this.save.snapshot.selectedCabinetSkin;

    for (const skin of skins) {
      const unlocked = this.save.isSkinUnlocked(kind, skin.id);
      const selected = skin.id === selectedId;

      const card = document.createElement('div');
      card.className = `skin-card${selected ? ' selected' : ''}${unlocked ? '' : ' locked'}`;
      card.dataset.skin = skin.id;
      card.dataset.kind = kind;
      if (kind === 'cabinet') card.append(cabinetPreview(skin as CabinetSkin));

      const swatch = document.createElement('span');
      swatch.className = 'skin-swatch';
      // 机柜色块取**主色** `panel`（背板 + 两侧高墙，画面面积最大、最能代表整套皮肤）。
      // ★ S20 之前取的是 `pusherTop` —— 那是推板顶面，也就是**币的舞台**：它必须取冷色
      // 才能把暖铜币托出来，拿它当色块等于让「色块好看」与「币好辨认」互相打架。
      swatch.style.background =
        kind === 'coin'
          ? (skin as CoinSkin).palette.bronze.base
          : (skin as CabinetSkin).colors.panel;
      card.append(swatch);

      const label = document.createElement('span');
      label.className = 'skin-name';
      label.textContent = skin.name;
      card.append(label);

      const action = document.createElement('button');
      action.type = 'button';
      if (selected) {
        action.textContent = '使用中';
        action.disabled = true;
      } else if (unlocked) {
        action.textContent = '选用';
        action.addEventListener('click', (event) => {
          event.preventDefault();
          this.select(kind, skin.id);
        });
      } else {
        action.textContent = `解锁（${skin.cost} 筹码）`;
        action.disabled = this.save.spendable < skin.cost;
        action.addEventListener('click', (event) => {
          event.preventDefault();
          this.unlock(kind, skin.id, skin.cost);
        });
      }
      card.append(action);

      container.append(card);
    }
  }

  private unlock(kind: 'coin' | 'cabinet', id: string, cost: number): void {
    const before = this.save.balance;
    if (!this.save.unlockSkin(kind, id, cost)) return;
    this.onPurchase(before - this.save.balance);
    this.save.selectSkin(kind, id);
    this.emitChange();
    this.refresh();
  }

  private select(kind: 'coin' | 'cabinet', id: string): void {
    if (!this.save.selectSkin(kind, id)) return;
    this.emitChange();
    this.refresh();
  }

  private emitChange(): void {
    this.onChange({
      coinSkin: coinSkinById(this.save.snapshot.selectedCoinSkin),
      cabinetSkin: cabinetSkinById(this.save.snapshot.selectedCabinetSkin),
    });
  }

  private el<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`缺少图鉴面板元素: ${selector}`);
    return element;
  }
}
