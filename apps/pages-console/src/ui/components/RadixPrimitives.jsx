import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Select from '@radix-ui/react-select';
import * as Tabs from '@radix-ui/react-tabs';
import { Check, ChevronDown, X } from 'lucide-react';

import { radixValueToSelectValue, selectValueToRadixValue } from '../select-model.js';

export function SelectField({ label, value, options, disabled = false, className = '', onChange }) {
  const selected = options.find((option) => option.value === value) || options[0];
  const rootValue = selectValueToRadixValue(value);
  return (
    <label className={className ? `field ${className}` : 'field'}>
      {label ? <span>{label}</span> : null}
      <Select.Root value={rootValue} disabled={disabled} onValueChange={(nextValue) => onChange(radixValueToSelectValue(nextValue))}>
        <Select.Trigger className="radix-select-trigger" aria-label={label}>
          <Select.Value placeholder={selected?.label} />
          <Select.Icon>
            <ChevronDown size={16} />
          </Select.Icon>
        </Select.Trigger>
        <Select.Portal>
          <Select.Content className="radix-select-content" position="popper" sideOffset={6}>
            <Select.Viewport>
              {options.map((option) => (
                <Select.Item className="radix-select-item" key={`${option.value}:${option.label}`} value={selectValueToRadixValue(option.value)}>
                  <Select.ItemIndicator className="radix-select-item__indicator">
                    <Check size={13} />
                  </Select.ItemIndicator>
                  <Select.ItemText>{option.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.Viewport>
          </Select.Content>
        </Select.Portal>
      </Select.Root>
    </label>
  );
}

export function IconDropdown({ label, icon, children }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="icon-button" type="button" aria-label={label} title={label}>
          {icon}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="radix-menu-content" sideOffset={8} align="end">
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function MenuItem({ active = false, icon, children, onSelect }) {
  return (
    <DropdownMenu.Item className={active ? 'radix-menu-item active' : 'radix-menu-item'} onSelect={onSelect}>
      <span className="radix-menu-item__icon">{icon}</span>
      <span>{children}</span>
      {active ? <Check className="radix-menu-item__check" size={14} /> : null}
    </DropdownMenu.Item>
  );
}

export function AppDialog({ open, title, eyebrow, children, footer, onOpenChange }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="radix-dialog-overlay" />
        <Dialog.Content className="radix-dialog-content">
          <div className="dialog-head">
            <div>
              {eyebrow ? <p>{eyebrow}</p> : null}
              <Dialog.Title>{title}</Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button className="icon-button compact" type="button" title="关闭">
                <X size={15} />
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog-body">{children}</div>
          {footer ? <div className="dialog-actions">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ConfirmDialog({
  open,
  title,
  eyebrow = '高风险操作',
  description,
  target,
  targetMeta,
  confirmLabel,
  cancelLabel = '取消',
  confirming = false,
  error,
  icon,
  onOpenChange,
  onCancel,
  onConfirm,
}) {
  const close = () => {
    if (confirming) return;
    onCancel?.();
    onOpenChange?.(false);
  };

  return (
    <AlertDialog.Root open={open} onOpenChange={(nextOpen) => {
      if (nextOpen) {
        onOpenChange?.(true);
        return;
      }
      close();
    }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="radix-dialog-overlay" />
        <AlertDialog.Content className="radix-dialog-content alert-dialog-content">
          <div className="dialog-head">
            <div>
              {eyebrow ? <p>{eyebrow}</p> : null}
              <AlertDialog.Title>{title}</AlertDialog.Title>
            </div>
          </div>
          <div className="dialog-body dialog-form">
            <div className="danger-summary">
              {icon}
              <span>
                <strong>{target}</strong>
                {targetMeta ? <small>{targetMeta}</small> : null}
              </span>
            </div>
            {description ? <AlertDialog.Description className="dialog-description">{description}</AlertDialog.Description> : null}
            {error ? <div className="form-error">{error.code || error.message || error}</div> : null}
            <div className="dialog-actions">
              <AlertDialog.Cancel asChild>
                <button className="secondary-button" type="button" disabled={confirming}>
                  {cancelLabel}
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  className="primary-button danger-primary-button"
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    onConfirm?.();
                  }}
                  disabled={confirming}
                >
                  {icon}
                  <span>{confirmLabel}</span>
                </button>
              </AlertDialog.Action>
            </div>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export const AppTabs = Tabs;
