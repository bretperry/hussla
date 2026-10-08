// Deep copy for the in-memory store: what the fake holds can't share a slice or map with what a caller passed in or got back.
// In the app: nothing at runtime (tests only).
// Used by: store.go in this package.
// Uses: reflect.
//
// A real database hands back fresh values on every read; a fake that stored the caller's slice
// would let a test mutate "the database" through a returned list and pass for the wrong reason.

package fakes

import "reflect"

// deepCopy copies a value with its slices, maps, pointers and nested structs. A struct with
// unexported fields (time.Time) is copied whole: those hold no mutable shared state here.
func deepCopy[T any](value T) T {
	copied := copyValue(reflect.ValueOf(&value).Elem())
	result, ok := copied.Interface().(T)
	if !ok {
		panic("fakes: deepCopy changed a value's type") // a broken invariant of copyValue
	}
	return result
}

func copyValue(source reflect.Value) reflect.Value {
	switch source.Kind() {
	case reflect.Pointer:
		if source.IsNil() {
			return source
		}
		target := reflect.New(source.Type().Elem())
		target.Elem().Set(copyValue(source.Elem()))
		return target
	case reflect.Slice:
		if source.IsNil() {
			return source
		}
		target := reflect.MakeSlice(source.Type(), source.Len(), source.Len())
		for index := range source.Len() {
			target.Index(index).Set(copyValue(source.Index(index)))
		}
		return target
	case reflect.Map:
		if source.IsNil() {
			return source
		}
		target := reflect.MakeMapWithSize(source.Type(), source.Len())
		for _, key := range source.MapKeys() {
			target.SetMapIndex(key, copyValue(source.MapIndex(key)))
		}
		return target
	case reflect.Struct:
		target := reflect.New(source.Type()).Elem()
		target.Set(source) // whole struct first, so unexported fields come along
		for index := range source.NumField() {
			if source.Type().Field(index).IsExported() {
				target.Field(index).Set(copyValue(source.Field(index)))
			}
		}
		return target
	case reflect.Invalid, reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64, reflect.Complex64, reflect.Complex128, reflect.String,
		reflect.Array, reflect.Chan, reflect.Func, reflect.Interface, reflect.UnsafePointer:
		// Plain values copy by assignment. (An array, interface or channel holding mutable state isn't used by any stored record.)
		return source
	}
	return source
}
