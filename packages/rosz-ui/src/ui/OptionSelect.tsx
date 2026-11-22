import type { ComponentProps, ReactNode } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select'

export type SelectOption = { value: string; label: ReactNode }

// Radix的选项值不能是空串 (留给"未选"), 而平台多处用空串表示"全部"/"不限"这样的选项: 进出各换一次
const EMPTY_VALUE = '__empty__'

/**
 * 单选下拉: 一组定值选项里选一个, 全站下拉都用它 (不用原生`<select>`, 其弹层由浏览器画, 不随主题).
 * 值可以是空串; 标签用`<Label htmlFor>`或`aria-label`给
 */
export function OptionSelect({
  value,
  onChange,
  options,
  ...trigger
}: {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
} & Omit<ComponentProps<typeof SelectTrigger>, 'value' | 'onChange' | 'children'>) {
  const encode = (raw: string) => (raw === '' ? EMPTY_VALUE : raw)
  return (
    <Select value={encode(value)} onValueChange={(next) => onChange(next === EMPTY_VALUE ? '' : next)}>
      <SelectTrigger {...trigger}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((option) => (
          <SelectItem key={option.value} value={encode(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
