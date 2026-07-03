export const EMPTY_SELECT_VALUE = '__xd_cell_empty_select_value__';

export function selectValueToRadixValue(value) {
  return value === '' ? EMPTY_SELECT_VALUE : String(value ?? '');
}

export function radixValueToSelectValue(value) {
  return value === EMPTY_SELECT_VALUE ? '' : value;
}
