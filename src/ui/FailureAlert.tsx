import { Alert, AlertDescription, AlertTitle } from './alert'

// 显示失败原因: 错误信息; 错误带字符串`code` (如ADP内核的失败码) 时另起一行给出
export function FailureAlert({ title, error }: { title: string; error: Error }) {
  const code = (error as Error & { code?: unknown }).code
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {typeof code === 'string' && <p className="font-mono text-xs">{code}</p>}
      </AlertDescription>
    </Alert>
  )
}
