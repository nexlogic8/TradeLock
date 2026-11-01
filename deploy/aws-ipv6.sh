#!/usr/bin/env bash
# Give the TradeLock server an IPv6 address so the app works on IPv4-only, IPv6-only and dual-stack
# networks. Run once in AWS CloudShell (region ap-south-1). Safe to re-run: every step checks first.
# IPv4 (13.235.49.88, the static IP whitelisted at Dhan) is not changed.
set -euo pipefail
export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-ap-south-1}
SERVER_IP=${SERVER_IP:-13.235.49.88}

say() { printf '\n==> %s\n' "$*"; }

say "Finding the instance with public IP $SERVER_IP"
read -r INSTANCE ENI SUBNET VPC < <(aws ec2 describe-instances \
  --filters "Name=ip-address,Values=$SERVER_IP" \
  --query 'Reservations[0].Instances[0].[InstanceId,NetworkInterfaces[0].NetworkInterfaceId,SubnetId,VpcId]' --output text)
[ "$INSTANCE" != "None" ] || { echo "No instance has $SERVER_IP in $AWS_DEFAULT_REGION"; exit 1; }
echo "instance=$INSTANCE eni=$ENI subnet=$SUBNET vpc=$VPC"

say "1/5 IPv6 block for the VPC"
VPC6=$(aws ec2 describe-vpcs --vpc-ids "$VPC" --query 'Vpcs[0].Ipv6CidrBlockAssociationSet[?Ipv6CidrBlockState.State==`associated`].Ipv6CidrBlock | [0]' --output text)
if [ "$VPC6" = "None" ]; then
  aws ec2 associate-vpc-cidr-block --vpc-id "$VPC" --amazon-provided-ipv6-cidr-block >/dev/null
  for _ in $(seq 1 30); do
    VPC6=$(aws ec2 describe-vpcs --vpc-ids "$VPC" --query 'Vpcs[0].Ipv6CidrBlockAssociationSet[?Ipv6CidrBlockState.State==`associated`].Ipv6CidrBlock | [0]' --output text)
    [ "$VPC6" != "None" ] && break; sleep 2
  done
fi
echo "VPC IPv6: $VPC6"

say "2/5 IPv6 /64 for the subnet"
SUB6=$(aws ec2 describe-subnets --subnet-ids "$SUBNET" --query 'Subnets[0].Ipv6CidrBlockAssociationSet[?Ipv6CidrBlockState.State==`associated`].Ipv6CidrBlock | [0]' --output text)
if [ "$SUB6" = "None" ]; then
  # Take the first /64 of the VPC's /56 (e.g. 2406:da1a:abc:d00::/56 -> 2406:da1a:abc:d00::/64).
  SUB6="${VPC6%/56}/64"
  aws ec2 associate-subnet-cidr-block --subnet-id "$SUBNET" --ipv6-cidr-block "$SUB6" >/dev/null
  sleep 3
fi
echo "Subnet IPv6: $SUB6"

say "3/5 Route ::/0 to the internet gateway"
RTB=$(aws ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$SUBNET" --query 'RouteTables[0].RouteTableId' --output text)
[ "$RTB" != "None" ] || RTB=$(aws ec2 describe-route-tables --filters "Name=vpc-id,Values=$VPC" "Name=association.main,Values=true" --query 'RouteTables[0].RouteTableId' --output text)
IGW=$(aws ec2 describe-internet-gateways --filters "Name=attachment.vpc-id,Values=$VPC" --query 'InternetGateways[0].InternetGatewayId' --output text)
HAS=$(aws ec2 describe-route-tables --route-table-ids "$RTB" --query 'RouteTables[0].Routes[?DestinationIpv6CidrBlock==`::/0`] | length(@)' --output text)
[ "$HAS" != "0" ] || aws ec2 create-route --route-table-id "$RTB" --destination-ipv6-cidr-block ::/0 --gateway-id "$IGW" >/dev/null
echo "route table $RTB -> $IGW"

say "4/5 Open web ports (80, 443) to IPv6"
for SG in $(aws ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].SecurityGroups[].GroupId' --output text); do
  for PORT in 80 443; do
    aws ec2 authorize-security-group-ingress --group-id "$SG" \
      --ip-permissions "IpProtocol=tcp,FromPort=$PORT,ToPort=$PORT,Ipv6Ranges=[{CidrIpv6=::/0,Description=web-ipv6}]" >/dev/null 2>&1 \
      && echo "$SG: opened $PORT/tcp for IPv6" || echo "$SG: $PORT/tcp for IPv6 already open"
  done
done

say "5/5 IPv6 address for the server"
IP6=$(aws ec2 describe-network-interfaces --network-interface-ids "$ENI" --query 'NetworkInterfaces[0].Ipv6Addresses[0].Ipv6Address' --output text)
if [ "$IP6" = "None" ]; then
  IP6=$(aws ec2 assign-ipv6-addresses --network-interface-id "$ENI" --ipv6-address-count 1 --query 'AssignedIpv6Addresses[0]' --output text)
fi

printf '\n============================================\n'
printf 'Server IPv6 address:  %s\n' "$IP6"
printf 'IPv4 (unchanged):     %s\n' "$SERVER_IP"
printf '============================================\n'
echo "Send this IPv6 address to Claude. Do NOT add the DNS record yet."
