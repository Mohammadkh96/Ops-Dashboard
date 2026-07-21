import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { onlineEmployees } from "@/lib/mock-dashboard";

export function TeamPanelCard() {
  return (
    <Card className="glass">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Team Online</CardTitle>
        <span className="text-xs text-muted-foreground">{onlineEmployees.length} online</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {onlineEmployees.map((employee) => (
          <div key={employee.name} className="flex items-center gap-3">
            <div className="relative">
              <Avatar>
                <AvatarFallback>{employee.initials}</AvatarFallback>
              </Avatar>
              <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-accent-green" />
            </div>
            <div className="flex flex-1 flex-col leading-tight">
              <span className="text-sm font-medium text-foreground">{employee.name}</span>
              <span className="text-xs text-muted">{employee.role}</span>
            </div>
            <span className="text-xs text-muted-foreground">{employee.workload} active</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
