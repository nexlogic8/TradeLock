#!/usr/bin/env bash
# AWS-level monitoring for TradeLock. Run once in AWS CloudShell (console → the >_ icon, top bar):
#
#   ALERT_EMAIL=you@example.com bash aws-alerts.sh
#
# Creates (safe to re-run; existing items are updated):
#   1. SNS topic "tradelock-alerts" emailing ALERT_EMAIL (confirm the subscription email AWS sends you)
#   2. EC2 status-check alarm: instance/system failure → email + automatic recovery (reboot)
#   3. CPU > 80% for 15 minutes → email
#   4. CPU credit balance low (t3 burstable) → email
#   5. Route 53 health check on https://<DOMAIN>/api/health every 30s → email when the site is down
#      (Route 53 health-check metrics live in us-east-1, so that alarm and its topic are created there.)
#
# Cost: CloudWatch alarms ~$0.10/month each, one Route 53 health check ~$0.75/month, SNS email free.
set -euo pipefail

ALERT_EMAIL="${ALERT_EMAIL:?Set ALERT_EMAIL=you@example.com}"
INSTANCE_ID="${INSTANCE_ID:-i-061f0338bf8b191ec}"
REGION="${REGION:-ap-south-1}"
DOMAIN="${DOMAIN:-tradelock.in}"
TOPIC=tradelock-alerts

topic() {   # $1 = region → prints topic ARN, subscribes the email once
  local arn
  arn=$(aws sns create-topic --region "$1" --name "$TOPIC" --query TopicArn --output text)
  if ! aws sns list-subscriptions-by-topic --region "$1" --topic-arn "$arn" --query 'Subscriptions[].Endpoint' --output text | grep -qi "$ALERT_EMAIL"; then
    aws sns subscribe --region "$1" --topic-arn "$arn" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
    echo "  → Confirmation email sent to $ALERT_EMAIL for $1. Click the link in it, or alerts won't arrive." >&2
  fi
  echo "$arn"
}

echo "Setting up alerts for $INSTANCE_ID ($REGION) and https://$DOMAIN"
ARN=$(topic "$REGION")

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name tradelock-instance-status \
  --alarm-description "TradeLock EC2 failed its system status check. AWS will try to recover it automatically." \
  --namespace AWS/EC2 --metric-name StatusCheckFailed_System --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --statistic Maximum --period 60 --evaluation-periods 2 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions "$ARN" "arn:aws:automate:$REGION:ec2:recover" --ok-actions "$ARN"

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name tradelock-instance-check \
  --alarm-description "TradeLock EC2 failed its instance status check (OS hung, out of memory, disk full). Rebooting it." \
  --namespace AWS/EC2 --metric-name StatusCheckFailed_Instance --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --statistic Maximum --period 60 --evaluation-periods 3 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions "$ARN" "arn:aws:automate:$REGION:ec2:reboot" --ok-actions "$ARN"

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name tradelock-cpu-high \
  --alarm-description "TradeLock CPU above 80% for 15 minutes." \
  --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --statistic Average --period 300 --evaluation-periods 3 --threshold 80 --comparison-operator GreaterThanThreshold \
  --alarm-actions "$ARN" --ok-actions "$ARN"

aws cloudwatch put-metric-alarm --region "$REGION" --alarm-name tradelock-cpu-credits-low \
  --alarm-description "TradeLock t3 CPU credit balance is low; the server will be throttled when it runs out." \
  --namespace AWS/EC2 --metric-name CPUCreditBalance --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
  --statistic Minimum --period 300 --evaluation-periods 2 --threshold 20 --comparison-operator LessThanThreshold \
  --treat-missing-data notBreaching --alarm-actions "$ARN" --ok-actions "$ARN"

# Website up check (from several AWS locations worldwide).
HC_ID=$(aws route53 list-health-checks --query "HealthChecks[?HealthCheckConfig.FullyQualifiedDomainName=='$DOMAIN' && HealthCheckConfig.ResourcePath=='/api/health'].Id | [0]" --output text)
if [ "$HC_ID" = "None" ] || [ -z "$HC_ID" ]; then
  HC_ID=$(aws route53 create-health-check --caller-reference "tradelock-$(date +%s)" \
    --health-check-config "Type=HTTPS,FullyQualifiedDomainName=$DOMAIN,Port=443,ResourcePath=/api/health,RequestInterval=30,FailureThreshold=3,EnableSNI=true" \
    --query HealthCheck.Id --output text)
  aws route53 change-tags-for-resource --resource-type healthcheck --resource-id "$HC_ID" --add-tags Key=Name,Value=tradelock-site
fi
ARN_US=$(topic us-east-1)
aws cloudwatch put-metric-alarm --region us-east-1 --alarm-name tradelock-site-down \
  --alarm-description "https://$DOMAIN is not responding (Route 53 health check)." \
  --namespace AWS/Route53 --metric-name HealthCheckStatus --dimensions Name=HealthCheckId,Value="$HC_ID" \
  --statistic Minimum --period 60 --evaluation-periods 2 --threshold 1 --comparison-operator LessThanThreshold \
  --alarm-actions "$ARN_US" --ok-actions "$ARN_US"

echo
echo "Done. Alarms:"
aws cloudwatch describe-alarms --region "$REGION" --alarm-name-prefix tradelock --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
aws cloudwatch describe-alarms --region us-east-1 --alarm-name-prefix tradelock --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
echo "Check your inbox ($ALERT_EMAIL) and confirm the AWS Notification subscription email(s)."
