import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Select from '@radix-ui/react-select';
import * as Tabs from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Check, ChevronDown, X } from 'lucide-react';
import { useCallback, useLayoutEffect, useRef } from 'react';

import { radixValueToSelectValue, selectValueToRadixValue } from '../select-model.js';

function usePreservedDialogScroll(open) {
  const scrollPositionRef = useRef(null);
  const openerRef = useRef(null);
  const locationRef = useRef('');
  const restoreFrameRef = useRef(null);
  const openRef = useRef(open);
  const wasOpenRef = useRef(false);

  useLayoutEffect(() => {
    return () => {
      openRef.current = false;
      if (restoreFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };
  }, []);

  useLayoutEffect(() => {
    openRef.current = open;
    if (restoreFrameRef.current !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = null;
    }
    if (open && !wasOpenRef.current && typeof window !== 'undefined') {
      scrollPositionRef.current = { x: window.scrollX, y: window.scrollY };
      openerRef.current = document.activeElement;
      locationRef.current = window.location.href;
    }
    wasOpenRef.current = open;
  }, [open]);

  const canRestoreScroll = useCallback(() => {
    if (typeof window === 'undefined') return false;
    return window.location.href === locationRef.current;
  }, []);

  const canRestoreFocus = useCallback(() => {
    if (!canRestoreScroll() || typeof document === 'undefined') return false;
    const opener = openerRef.current;
    return opener?.isConnected && opener.ownerDocument === document;
  }, [canRestoreScroll]);

  const restoreScroll = useCallback(() => {
    if (!canRestoreScroll() || !scrollPositionRef.current) return;
    if (restoreFrameRef.current !== null) {
      window.cancelAnimationFrame(restoreFrameRef.current);
    }
    const { x, y } = scrollPositionRef.current;
    const openState = openRef.current;
    restoreFrameRef.current = window.requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      if (openRef.current !== openState || !canRestoreScroll()) return;
      window.scrollTo(x, y);
    });
  }, [canRestoreScroll]);

  const restoreFocusAndScroll = useCallback((event) => {
    if (openRef.current || !canRestoreScroll()) return;
    event.preventDefault();
    const opener = canRestoreFocus() ? openerRef.current : null;
    if (opener && typeof opener.focus === 'function') {
      opener.focus({ preventScroll: true });
    }
    restoreScroll();
  }, [canRestoreFocus, canRestoreScroll, restoreScroll]);

  return { restoreScroll, restoreFocusAndScroll };
}

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

export function Tooltip({ content, children, side = 'bottom', align = 'center' }) {
  return (
    <TooltipPrimitive.Provider delayDuration={180}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content className="radix-tooltip-content" side={side} align={align} sideOffset={8}>
            {content}
            <TooltipPrimitive.Arrow className="radix-tooltip-arrow" />
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
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

export function AppDialog({ open, title, eyebrow, children, footer, initialFocusRef, onOpenChange }) {
  const { restoreScroll, restoreFocusAndScroll } = usePreservedDialogScroll(open);
  const handleOpenAutoFocus = useCallback((event) => {
    const target = initialFocusRef?.current;
    if (target?.isConnected && typeof target.focus === 'function') {
      event.preventDefault();
      target.focus({ preventScroll: true });
    }
    restoreScroll();
  }, [initialFocusRef, restoreScroll]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="radix-dialog-overlay" />
        <Dialog.Content
          className="radix-dialog-content"
          onOpenAutoFocus={handleOpenAutoFocus}
          onCloseAutoFocus={restoreFocusAndScroll}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
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
  const { restoreScroll, restoreFocusAndScroll } = usePreservedDialogScroll(open);
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
        <AlertDialog.Content
          className="radix-dialog-content alert-dialog-content"
          onOpenAutoFocus={restoreScroll}
          onCloseAutoFocus={restoreFocusAndScroll}
        >
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
