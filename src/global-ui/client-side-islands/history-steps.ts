interface NavigationState {
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export function mountHistorySteps(root: ParentNode = document): void {
  const navigation = (window as { navigation?: NavigationState }).navigation;
  for (const steps of root.querySelectorAll<HTMLElement>('[data-spr-history]')) {
    const back = steps.querySelector<HTMLButtonElement>('[data-spr-history-back]');
    const forward = steps.querySelector<HTMLButtonElement>('[data-spr-history-forward]');
    if (back) {
      back.disabled = navigation?.canGoBack === false;
      back.addEventListener('click', () => history.back());
    }
    if (forward) {
      forward.disabled = navigation?.canGoForward === false;
      forward.addEventListener('click', () => history.forward());
    }
    steps.hidden = false;
  }
}
