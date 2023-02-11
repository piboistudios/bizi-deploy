while read p; do
  kubectl delete pod 	$p	 --grace-period=0 --force
done <$1